# Build Guide: System Grounding

Local development setup, testing, and deployment instructions for the System Grounding project.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [Running Tests](#running-tests)
4. [Full Project Validation](#full-project-validation)
5. [Linting CloudFormation](#linting-cloudformation)
6. [Deploying to AWS](#deploying-to-aws)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software

- **Node.js** v20+ ([download](https://nodejs.org))
- **Python** 3.10+ ([download](https://python.org))
- **AWS CLI** v2+ ([install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html))
- **Vercel CLI** (optional, for dashboard deployment)

### AWS Configuration

```bash
# Configure AWS credentials
aws configure

# Verify configuration
aws sts get-caller-identity
```

---

## Local Development Setup

### Dashboard (Next.js)

```bash
cd dashboard

# Install dependencies
npm install

# Set environment variables (create .env.local)
cat > .env.local << EOF
DYNAMODB_TABLE_NAME=SystemState
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
EOF

# Run development server
npm run dev

# Open http://localhost:3000
```

**Environment Variables:**

| Variable | Description | Example |
|----------|-------------|---------|
| `DYNAMODB_TABLE_NAME` | DynamoDB table name | `SystemState` |
| `AWS_ACCESS_KEY_ID` | IAM access key | `AKIA...` |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key | `...` |
| `AWS_REGION` | AWS region | `us-east-1` |

### MCP Server (TypeScript)

```bash
cd mcp

# Install dependencies
npm install

# Build the server
npm run build

# Run locally (for testing)
npm run start

# The server runs on stdio (for Cursor integration)
```

**Configure in Cursor IDE:**

1. Open Cursor Settings → MCP
2. Add new server:
   ```json
   {
     "system-grounding": {
       "command": "node",
       "args": ["/absolute/path/to/mcp/dist/index.js"]
     }
   }
   ```

### Agent (Python)

```bash
cd agent

# Create virtual environment (optional but recommended)
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install requests pyyaml

# Run the agent (--api-key is required unless --dry-run is used;
# alternatively export INGEST_API_KEY or API_KEY)
python agent.py \
  --device-id "dev-machine" \
  --api-url "http://localhost:3000/api/ingest" \
  --api-key "local-dev-key" \
  --interval 60
```

**Note**: For local testing without AWS deployment, you'll need to mock the ingestion API endpoint. Use `--dry-run` to verify collection without any endpoint or key.

---

## Running Tests

### Lambda Tests (Jest)

```bash
cd lambdas

# Install dependencies
npm install

# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- ingestApi.test.js
```

**Test Files:**

- `__tests__/ingestApi.test.js` - Ingestion API handler tests
- `__tests__/diffProcessor.test.js` - Diff processor tests

### Dashboard Tests

The dashboard currently has no test suite configured (`dashboard/package.json`
defines no `test` script). Use `npm run build` to verify it compiles.

### Agent Tests (Python)

The agent currently has no pytest suite. Verify it locally with a dry run,
which collects records and prints them without sending anything:

```bash
cd agent
python agent.py --device-id test-device --dry-run
```

---

## Full Project Validation

`validate.sh` (run by the GitHub Actions workflow on every push/PR to
`main`) performs an end-to-end check of the project:

1. Verifies all required source files exist
2. Lints the CloudFormation template (cfn-lint) and type-checks the MCP server (`tsc`)
3. Starts the dashboard dev server and exercises the `/api/ask` endpoint
4. Runs the Python agent with `--dry-run`
5. Builds and starts the MCP server to verify it initializes

```bash
./validate.sh
```

---

## Linting CloudFormation

### Using cfn-lint

```bash
# Install cfn-lint
pip install cfn-lint

# Lint the template
cfn-lint template.yaml

# Lint with warnings enabled
cfn-lint template.yaml --include-checks

# Output format options
cfn-lint template.yaml --format pretty
```

### Using AWS CloudFormation Validator

```bash
# Validate template syntax
aws cloudformation validate-template \
  --template-body file://template.yaml
```

### Common Issues & Fixes

| Issue | Fix |
|-------|-----|
| `E3001: Resource not found` | Ensure all resource references exist |
| `E1029: Sub parameters` | Use proper `!Sub` syntax |
| `W3002: Hard-coded ARN` | Use `!Sub` or `!GetAtt` for dynamic ARNs |

---

## Deploying to AWS

### Deploy CloudFormation Stack

```bash
# Basic deployment
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name system-grounding \
  --capabilities CAPABILITY_IAM

# With custom parameters
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name system-grounding \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ChangeRecordTTLDays=7 \
    VercelDashboardUser=my-vercel-user
```

### Get Stack Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name system-grounding \
  --query 'Stacks[0].Outputs' \
  --output table
```

**Key Outputs:**

- `TableName` - DynamoDB table name
- `IngestApiUrl` - API Gateway endpoint URL
- `VercelAccessKeyId` - IAM access key for dashboard
- `VercelSecretAccessKey` - IAM secret key for dashboard

### Update Stack

```bash
# After modifying template.yaml
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name system-grounding \
  --capabilities CAPABILITY_IAM
```

### Delete Stack

```bash
aws cloudformation delete-stack --stack-name system-grounding
```

---

## Deploying Dashboard to Vercel

### Option 1: Vercel CLI

```bash
cd dashboard

# Login to Vercel
vercel login

# Deploy to production
vercel deploy --prod
```

### Option 2: GitHub Integration

1. Push code to GitHub:
   ```bash
   git push origin main
   ```

2. Connect repository in Vercel dashboard:
   - Go to [vercel.com](https://vercel.com)
   - Import GitHub repository
   - Configure environment variables (see below)
   - Deploy

### Environment Variables in Vercel

In Vercel Project Settings → Environment Variables:

| Variable | Value |
|----------|-------|
| `DYNAMODB_TABLE_NAME` | From CloudFormation output |
| `AWS_ACCESS_KEY_ID` | From CloudFormation output |
| `AWS_SECRET_ACCESS_KEY` | From CloudFormation output |
| `AWS_REGION` | Your AWS region |

---

## Troubleshooting

### Dashboard Can't Connect to DynamoDB

**Symptoms**: API returns 500 errors, "credentials not found"

**Fix**:
1. Verify environment variables are set correctly
2. Check IAM user has correct permissions
3. Ensure AWS region matches your DynamoDB table region

```bash
# Test credentials
aws dynamodb list-tables \
  --profile your-profile \
  --region us-east-1
```

### Agent Fails to Send Data

**Symptoms**: Agent logs show HTTP 4xx/5xx errors

**Fix**:
1. Verify API Gateway URL is correct
2. Check API Gateway deployment status
3. Review CloudWatch logs for Lambda errors

```bash
# Get API URL from stack
aws cloudformation describe-stacks \
  --stack-name system-grounding \
  --query 'Stacks[0].Outputs[?OutputKey==`IngestApiUrl`].OutputValue'
```

### MCP Server Not Working in Cursor

**Symptoms**: Cursor doesn't recognize MCP tools

**Fix**:
1. Rebuild MCP server: `npm run build`
2. Restart Cursor IDE
3. Verify MCP server path in settings
4. Check server logs in Cursor Developer Tools

### DynamoDB Stream Not Triggering Diff Processor

**Symptoms**: CHANGE# records not being created

**Fix**:
1. Verify stream is enabled on table:
   ```bash
   aws dynamodb describe-table \
     --table-name SystemState \
     --query 'Table.StreamSpecification'
   ```
2. Check Event Source Mapping status:
   ```bash
   aws lambda list-event-source-mappings \
     --function-name DiffProcessorFunction
   ```
3. Review Lambda function logs in CloudWatch

---

## Quick Reference Commands

```bash
# Deploy infrastructure
aws cloudformation deploy --template-file template.yaml --stack-name system-grounding --capabilities CAPABILITY_IAM

# Get outputs
aws cloudformation describe-stacks --stack-name system-grounding --query 'Stacks[0].Outputs'

# Run dashboard locally
cd dashboard && npm install && npm run dev

# Build MCP server
cd mcp && npm install && npm run build

# Run agent
python agent/agent.py --device-id "my-device" --api-url "https://..." --api-key "<x-api-key>"

# Lint CloudFormation
cfn-lint template.yaml

# Run Lambda tests
cd lambdas && npm test
```

---

## Additional Resources

- [AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/)
- [DynamoDB Streams Documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Next.js Documentation](https://nextjs.org/docs)
