// STATUS: research
// This file is NOT the code deployed by template.yaml. The deployed diff
// processor is the inline ZipFile in template.yaml, which writes CHANGE#
// audit records back to the table. This standalone variant only logs diffs.
// Reconcile or remove before relying on either.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Computes the difference between old and new objects.
 * - If no oldItem exists (INSERT), returns { added: [keys] }
 * - If no newItem exists (REMOVE), returns { removed: [keys] }
 * - If both exist (MODIFY), returns { changed: { key: { old, new } } }
 * @param {Object} newItem - The new item from the stream (may be undefined)
 * @param {Object} oldItem - The old item from the stream (may be undefined)
 * @returns {Object} - Diff result
 */
function computeDiff(newItem, oldItem) {
    if (!oldItem) {
        // INSERT event - all keys are "added"
        const added = Object.keys(newItem || {});
        return { added };
    }

    if (!newItem) {
        // REMOVE event - all keys are "removed"
        const removed = Object.keys(oldItem);
        return { removed };
    }

    // MODIFY event - find changed keys
    const changed = {};
    const allKeys = new Set([...Object.keys(newItem), ...Object.keys(oldItem)]);

    for (const key of allKeys) {
        const newVal = newItem[key];
        const oldVal = oldItem[key];

        // Compare values (simple equality check)
        if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
            changed[key] = { old: oldVal, new: newVal };
        }
    }

    return { changed };
}

/**
 * Lambda handler for processing DynamoDB Stream events.
 * Implements batch item failure collection for partial failures.
 * @param {Object} event - DynamoDB Stream event
 * @returns {Object} - Response with batchItemFailures if any failures occurred
 */
async function handler(event) {
    const batchItemFailures = [];

    for (const record of event.Records) {
        try {
            const eventName = record.eventName; // INSERT, MODIFY, REMOVE
            const dynamodb = record.dynamodb;

            let newItem, oldItem;

            if (dynamodb.NewImage) {
                newItem = unmarshallDynamoDB(dynamodb.NewImage);
            }
            if (dynamodb.OldImage) {
                oldItem = unmarshallDynamoDB(dynamodb.OldImage);
            }

            // Compute the diff
            const diff = computeDiff(newItem, oldItem);

            // Process based on event type
            if (eventName === 'REMOVE') {
                // Handle removal - could archive or notify
                console.log('Record removed:', { key: dynamodb.Keys, diff });
            } else if (eventName === 'INSERT') {
                console.log('New record inserted:', { data: newItem, diff });
            } else if (eventName === 'MODIFY') {
                console.log('Record modified:', { diff });
            }

            // Additional processing logic can be added here
            // For example: write to another table, send SNS notification, etc.

        } catch (error) {
            console.error('Error processing record:', error);
            // Add the failed record's sequence number to batchItemFailures
            batchItemFailures.push({
                itemIdentifier: record.dynamodb.SequenceNumber
            });
        }
    }

    // Return batchItemFailures if any failures occurred
    if (batchItemFailures.length > 0) {
        return { batchItemFailures };
    }

    return {};
}

/**
 * Helper function to unmarshall DynamoDB AttributeValues
 * @param {Object} item - DynamoDB AttributeValue map
 * @returns {Object} - Plain JavaScript object
 */
function unmarshallDynamoDB(item) {
    const result = {};
    for (const [key, value] of Object.entries(item)) {
        result[key] = unmarshallValue(value);
    }
    return result;
}

/**
 * Helper to unmarshall a single DynamoDB AttributeValue
 * @param {Object} value - DynamoDB AttributeValue
 * @returns {*} - JavaScript value
 */
function unmarshallValue(value) {
    const types = Object.keys(value);
    if (types.length !== 1) {
        throw new Error('Invalid AttributeValue: must have exactly one type');
    }

    const type = types[0];
    const val = value[type];

    switch (type) {
        case 'S':
            return val;
        case 'N':
            return Number(val);
        case 'BOOL':
            return val;
        case 'NULL':
            return null;
        case 'L':
            return val.map(unmarshallValue);
        case 'M':
            return unmarshallDynamoDB(val);
        case 'SS':
            return val;
        case 'NS':
            return val.map(Number);
        case 'BS':
            return val;
        case 'B':
            return Buffer.from(val, 'base64');
        default:
            throw new Error(`Unknown type: ${type}`);
    }
}

module.exports = {
    handler,
    computeDiff,
    unmarshallDynamoDB,
    unmarshallValue
};
