// Canonical, testable copy of the inline ZipFile ingest handler deployed by
// template.yaml (resource IngestApiFunction). KEEP IN SYNC WITH THE TEMPLATE:
// CloudFormation deploys the inline copy; this file exists so the same logic
// is covered by the Jest suite. If you change one, change the other.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});

// Created lazily so tests can mock DynamoDBDocumentClient.from; at Lambda
// runtime this is equivalent (env is fixed before the handler runs).
let docClient;
function getDocClient() {
    if (!docClient) {
        docClient = DynamoDBDocumentClient.from(client);
    }
    return docClient;
}

/**
 * Lambda handler for the API Gateway POST /ingest endpoint.
 * Accepts { deviceId, records: [...] } batches and writes each record as a
 * DEVICE#/TYPE# item with TTL and freshness metadata.
 * @param {Object} event - API Gateway proxy event
 * @returns {Object} - HTTP response with CORS headers
 */
async function handler(event) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ''
        };
    }

    try {
        const body = JSON.parse(event.body || '');

        if (!body || typeof body !== 'object') {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Invalid request. Requires deviceId and records array.' })
            };
        }

        const { deviceId, records } = body;

        if (!deviceId || !Array.isArray(records)) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Invalid request. Requires deviceId and records array.' })
            };
        }

        const now = Math.floor(Date.now() / 1000);
        const results = [];

        for (const record of records) {
            const { recordType, id, data, stalenessThresholdSeconds } = record;
            const ttl = now + (stalenessThresholdSeconds || 86400);

            await getDocClient().send(new PutCommand({
                TableName: process.env.TABLE_NAME,
                Item: {
                    PK: `DEVICE#${deviceId}`,
                    SK: `TYPE#${recordType}#${id}`,
                    recordType: recordType,
                    deviceId: deviceId,
                    id: id,
                    data: data,
                    lastCollected: new Date().toISOString(),
                    stalenessThresholdSeconds: stalenessThresholdSeconds || 86400,
                    ttl: ttl
                }
            }));

            results.push({ recordType, id, status: 'success' });
        }

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ success: true, results })
        };
    } catch (error) {
        if (error instanceof SyntaxError) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Invalid JSON in request body' })
            };
        }
        console.error('Error ingesting records:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
}

module.exports = {
    handler
};
