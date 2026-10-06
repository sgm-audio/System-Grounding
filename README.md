# System Grounding

Ground AI queries in verified local system state to eliminate hallucinations about packages, configs, and services.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────┐     ┌────────────┐
│   Agent     │────▶│  API Gateway │────▶│  Lambda   │────▶│ DynamoDB   │
│ (Python)    │     │  (Ingest)    │     │ (Ingest)  │     │ (State)    │
└─────────────┘     └──────────────┘     └───────────┘     └─────┬──────┘
                                                                 │
                    ┌──────────────┐                             │
                    │ Diff Processor│◀────────────────────────────┘
                    │ (Lambda)      │  (DynamoDB Streams)
                    └──────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │ CHANGE#      │
                    │ Records      │
                    └──────────────┘

┌─────────────┐     ┌──────────────┐
│  Dashboard  │────▶│  DynamoDB    │
│  (Next.js)  │     │  (Query)     │
└─────────────┘     └──────────────┘

┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│     MCP     │────▶│  Dashboard   │────▶│  DynamoDB    │
│  (Cursor)   │     │  (/api/ask)  │     │  (Query)     │
└─────────────┘     └──────────────┘     └──────────────┘
```

**Flow:**
1. **Agent → API Gateway → Lambda → DynamoDB**: Python agent collects system state (packages, configs, env vars, services) and sends to ingestion API
2. **DynamoDB ↔ Diff Processor**: DynamoDB Streams trigger Lambda to compute diffs and write `CHANGE#` records for audit trail
3. **Dashboard / MCP → DynamoDB**: The Next.js dashboard queries verified state for grounded AI responses; the Cursor MCP server calls the dashboard's `/api/ask` endpoint (`GROUNDING_API_URL`), which in turn queries DynamoDB

## Features

- **🎯 Grounded Queries**: AI responses backed by verified system state from DynamoDB
- **📊 Live Diff Tracking**: Automatic change detection via DynamoDB Streams with `CHANGE#` records
- **🔌 MCP Integration**: Cursor IDE integration via Model Context Protocol server
- **🔒 Least-Privilege Security**: IAM policies restrict dashboard to read-only + PutItem, deny DeleteItem/Scan
- **⏰ TTL Management**: Configurable time-to-live for records with automatic expiration
- **🚫 Denylist Filtering**: Sensitive environment variables (SECRET, TOKEN, PASSWORD, AWS_*) automatically excluded

## Quick Start

### Step 1: Deploy CloudFormation Stack

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name system-grounding \
  --capabilities CAPABILITY_IAM
```

This creates:
- DynamoDB table (`SystemState`) with single-table design
- Ingestion API (API Gateway + Lambda)
- Diff Processor Lambda (triggered by DynamoDB Streams)
- IAM user with least-privilege access for Vercel dashboard

### Step 2: Set Vercel Environment Variables

After deployment, get the outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name system-grounding \
  --query 'Stacks[0].Outputs'
```

Set these in your Vercel project:

| Variable | Value From Output |
|----------|-------------------|
| `DYNAMODB_TABLE_NAME` | `TableName` |
| `AWS_ACCESS_KEY_ID` | `VercelAccessKeyId` |
| `AWS_SECRET_ACCESS_KEY` | `VercelSecretAccessKey` |
| `AWS_REGION` | Your AWS region (e.g., `us-east-1`) |

### Step 3: Deploy Vercel Dashboard

```bash
cd dashboard
npm install

# Option A: Deploy via Vercel CLI
vercel deploy --prod

# Option B: Push to GitHub and connect via Vercel UI
git push origin main
```

### Step 4: Run the Local Agent

The ingest endpoint requires an API key (`x-api-key`). The stack creates one
and exports its key id as the `IngestApiKeyId` output; retrieve the actual
key value with `get-api-key --include-value`:

```bash
# Get the ingest API URL from CloudFormation outputs
INGEST_URL=$(aws cloudformation describe-stacks \
  --stack-name system-grounding \
  --query 'Stacks[0].Outputs[?OutputKey==`IngestApiUrl`].OutputValue' \
  --output text)

# Get the API key value (IngestApiKeyId output holds the key id)
INGEST_KEY_ID=$(aws cloudformation describe-stacks \
  --stack-name system-grounding \
  --query 'Stacks[0].Outputs[?OutputKey==`IngestApiKeyId`].OutputValue' \
  --output text)
INGEST_KEY=$(aws apigateway get-api-key \
  --api-key "$INGEST_KEY_ID" --include-value --query 'value' --output text)

# Run the agent (alternatively: export INGEST_API_KEY="$INGEST_KEY")
python agent/agent.py \
  --device-id "framework-13" \
  --api-url "$INGEST_URL" \
  --api-key "$INGEST_KEY" \
  --interval 60
```

## Configuration

### TTL (Time-To-Live)

Records automatically expire based on TTL. Configure via CloudFormation parameter:

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name system-grounding \
  --parameter-overrides ChangeRecordTTLDays=7 \
  --capabilities CAPABILITY_IAM
```

- **Default**: 30 days for change records
- **Per-record**: Agents can set `stalenessThresholdSeconds` (default: 86400 = 24 hours); it is persisted on each item and used both for TTL and for the dashboard's freshness check

### Denylist

Environment variables matching these patterns are automatically excluded:

```python
ENV_DENYLIST_PATTERNS = [
    r"SECRET", r"TOKEN", r"PASSWORD", r"API_KEY", r"INGEST_API_KEY",
    r"AWS_", r"GITHUB_", r"NPM_TOKEN", r"DOCKER_PASSWORD"
]
```

See `agent/agent.py` for the authoritative list.

### Adding New Record Types

To collect a new type of system state:

1. **Add collection function** in `agent/agent.py`:

```python
def collect_services() -> list[dict[str, Any]]:
    records = []
    # ... collection logic ...
    records.append({
        "recordType": "SERVICE",
        "id": name,
        "data": {"name": name, "status": "active"},
        "stalenessThresholdSeconds": 300,
    })
    return records
```

2. **Call it in `main()`**:

```python
all_records.extend(collect_services())
```

3. **Add intent mapping** in `dashboard/pages/api/ask.js`:

```javascript
{ keywords: /service|systemd/i, types: ['SERVICE'] },
```

> **Note**: The LLM answer in the demo is simulated. In production, replace the simulated response in `dashboard/pages/api/ask.js` with an actual LLM API call (e.g., Anthropic, OpenAI) that receives the verified context.

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Infrastructure** | AWS CloudFormation, Lambda, API Gateway, DynamoDB |
| **Agent** | Python 3, requests, pyyaml |
| **Dashboard** | Next.js, React, AWS SDK v3 |
| **MCP Server** | TypeScript, @modelcontextprotocol/sdk |
| **Security** | IAM least-privilege policies, TTL-based expiration |

## Project Structure

```
/
├── template.yaml          # CloudFormation stack (deployed Lambda code lives
│                          # inline here as ZipFile functions)
├── validate.sh            # End-to-end validation script (run in CI)
├── agent/
│   ├── agent.py           # Python state collector
│   └── requirements.txt
├── lambdas/
│   ├── ingestApi.js       # Testable copy of the deployed ingest handler
│   ├── diffProcessor.js   # Testable copy of the deployed diff processor
│   └── __tests__/         # Jest suite covering the deployed logic
├── dashboard/
│   ├── pages/
│   │   ├── index.js       # Main dashboard UI
│   │   ├── _app.js        # Custom App (global CSS import)
│   │   └── api/ask.js     # Grounded query endpoint
│   └── package.json
├── mcp/
│   ├── src/index.ts       # Cursor MCP server
│   └── package.json
├── BUILD.md               # Local development / testing / deployment guide
└── README.md              # This file
```

> **Note**: The Lambda functions actually deployed by CloudFormation are the
> inline `ZipFile` definitions in `template.yaml`. The files in `lambdas/`
> are canonical, testable copies of that same logic covered by the Jest
> suite. **Keep both in sync** — if you change one, change the other (a
> future improvement would be packaging `lambdas/` directly instead of
> using inline code).

## License

MIT
