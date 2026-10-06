// API endpoint for grounding middleware that validates AI queries against stored state
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'SystemState';

// Hardcoded keyword-to-record-type map
const INTENT_MAP = [
  { keywords: /portal|game mode|bazzite/i, types: ['CONFIG#/etc/bazzite/portal.yaml', 'SERVICE#bazzite-portal'] },
  { keywords: /package|install|version|rpm|flatpak/i, types: ['PACKAGE'] },
  { keywords: /gpu|driver|nvidia|radeon/i, types: ['HARDWARE'] },
  { keywords: /env|path|variable/i, types: ['ENV'] },
];

function detectIntent(query) {
  const matchedTypes = [];
  for (const { keywords, types } of INTENT_MAP) {
    if (keywords.test(query)) {
      matchedTypes.push(...types);
    }
  }
  // Fallback to default config
  if (matchedTypes.length === 0) {
    matchedTypes.push('CONFIG#/etc/bazzite/portal.yaml');
  }
  return [...new Set(matchedTypes)];
}

async function fetchRecords(requiredTypes, pk) {
  const items = {};
  const missing = [];
  for (const type of requiredTypes) {
    const parts = type.split('#');
    if (parts.length >= 3) {
      // Full SK given, use GetItem
      const sk = `TYPE#${type}`;
      try {
        const cmd = new GetCommand({
          TableName: TABLE_NAME,
          Key: { PK: pk, SK: sk },
        });
        const result = await docClient.send(cmd);
        if (result.Item) {
          items[sk] = result.Item;
        } else {
          missing.push(type);
        }
      } catch (e) {
        console.error(`Error fetching ${sk}:`, e);
        missing.push(type);
      }
    } else {
      // Type (optionally with a specific id), use Query with begins_with.
      // No trailing '#': a specific id like 'CONFIG#/etc/bazzite/portal.yaml'
      // has an SK of exactly 'TYPE#CONFIG#/etc/bazzite/portal.yaml'.
      const prefix = `TYPE#${type}`;
      try {
        const cmd = new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': pk,
            ':skPrefix': prefix,
          },
        });
        const result = await docClient.send(cmd);
        const found = result.Items || [];
        if (found.length === 0) {
          missing.push(type);
        }
        for (const item of found) {
          items[item.SK] = item;
        }
      } catch (e) {
        console.error(`Error querying ${prefix}:`, e);
        missing.push(type);
      }
    }
  }
  return { items, missing };
}

function buildContextString(items) {
  const lines = [];
  const stale = [];
  const now = Date.now();

  for (const [sk, item] of Object.entries(items)) {
    const data = item.data || {};
    const threshold = (item.stalenessThresholdSeconds || 86400) * 1000;
    // Ingest writes `lastCollected` as an ISO-8601 string.
    const updatedAt = item.lastCollected ? Date.parse(item.lastCollected) : NaN;
    const age = Number.isNaN(updatedAt) ? Infinity : now - updatedAt;
    const isStale = age > threshold;

    lines.push(`--- Record: ${sk} ---`);
    lines.push(`Data: ${JSON.stringify(data, null, 2)}`);
    if (isStale) {
      const ageLabel = Number.isFinite(age) ? `${Math.round(age / 1000)}s` : 'unknown (no lastCollected)';
      lines.push(`⚠️ STALE (age: ${ageLabel}, threshold: ${threshold / 1000}s)`);
      stale.push(sk);
    }
    lines.push('');
  }

  return {
    context: lines.join('\n'),
    stale,
  };
}

function computeConfidence(stale, missing) {
  if (missing.length > 0) {
    return 0.2;
  }
  let confidence = 1.0 - stale.length * 0.5;
  if (stale.length === 0) {
    confidence = Math.min(confidence, 0.98);
  }
  return Math.max(0, confidence);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body || {};
  const deviceId = req.headers['x-device-id'] || 'framework-13';

  if (!query) {
    return res.status(400).json({ error: 'Missing query in request body' });
  }

  console.log(`Grounding query from device ${deviceId}:`, query);

  // Detect intent and get required record types
  const requiredTypes = detectIntent(query);
  console.log('Required types:', requiredTypes);

  // Records are stored per device: PK = DEVICE#<deviceId>
  // (see the inline ingest Lambda in template.yaml)
  const pk = `DEVICE#${deviceId}`;

  // Fetch records from DynamoDB
  const { items, missing } = await fetchRecords(requiredTypes, pk);
  console.log('Fetched items:', Object.keys(items));

  // Build context string
  const { context, stale } = buildContextString(items);

  // Compute confidence
  const confidenceScore = computeConfidence(stale, missing);

  // Simulate LLM answer
  const answer = `[Simulated] Based on verified state:\n\n${context}\n\n[End of verified context]`;

  // Determine confidence tier
  let confidenceTier;
  if (confidenceScore > 0.8) {
    confidenceTier = 'VERIFIED';
  } else if (confidenceScore > 0.5) {
    confidenceTier = 'PARTIAL';
  } else {
    confidenceTier = 'UNGROUNDED';
  }

  res.status(200).json({
    answer,
    confidenceScore,
    confidenceTier,
    contextProvided: context,
    staleRecords: stale,
    missingData: missing,
  });
}
