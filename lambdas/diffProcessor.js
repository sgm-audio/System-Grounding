// Canonical, testable copy of the inline ZipFile diff processor deployed by
// template.yaml (resource DiffProcessorFunction). KEEP IN SYNC WITH THE
// TEMPLATE: CloudFormation deploys the inline copy; this file exists so the
// same logic is covered by the Jest suite. If you change one, change the other.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

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
 * Computes the difference between old and new data objects.
 * @param {Object} oldObj - Previous data (may be undefined for INSERT)
 * @param {Object} newObj - New data
 * @returns {Object} - Map of changed keys to { old, new } values
 */
function computeDiff(oldObj, newObj) {
    const diff = {};
    const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
    for (const key of allKeys) {
        if (JSON.stringify(oldObj?.[key]) !== JSON.stringify(newObj?.[key])) {
            diff[key] = { old: oldObj?.[key], new: newObj?.[key] };
        }
    }
    return diff;
}

/**
 * DynamoDB Streams handler: writes CHANGE# audit records for every
 * INSERT/MODIFY/REMOVE event on the SystemState table.
 * Implements partial batch failure reporting (ReportBatchItemFailures).
 * @param {Object} event - DynamoDB Streams event
 * @returns {Object} - { batchItemFailures }
 */
async function handler(event) {
    const batchItemFailures = [];
    const ttlDays = parseInt(process.env.TTL_DAYS) || 30;
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + (ttlDays * 86400);

    for (const record of event.Records) {
        try {
            const eventName = record.eventName;
            const streamRecord = record.dynamodb;

            // Stream images arrive as DynamoDB AttributeValue maps
            // (e.g. deviceId: { S: 'framework-13' }); unmarshall them so
            // keys, ids, and snapshots use plain values.
            const newImage = streamRecord.NewImage ? unmarshall(streamRecord.NewImage) : undefined;
            const oldImage = streamRecord.OldImage ? unmarshall(streamRecord.OldImage) : undefined;

            if (eventName === 'REMOVE') {
                if (!oldImage) continue;

                const deviceId = oldImage.deviceId;
                const recordType = oldImage.recordType;
                const id = oldImage.id;
                const timestamp = new Date().toISOString();

                await getDocClient().send(new PutCommand({
                    TableName: process.env.TABLE_NAME,
                    Item: {
                        PK: `CHANGE#${deviceId}`,
                        SK: `${timestamp}#DELETE#TYPE#${recordType}#${id}#${record.eventID}`,
                        changeType: 'DELETE',
                        recordType: recordType,
                        deviceId: deviceId,
                        changeDevice: deviceId,
                        changeTimestamp: timestamp,
                        oldSnapshot: oldImage.data || oldImage,
                        ttl: ttl
                    }
                }));
            } else if (eventName === 'INSERT' || eventName === 'MODIFY') {
                if (!newImage) continue;

                const deviceId = newImage.deviceId;
                const recordType = newImage.recordType;
                const id = newImage.id;
                const timestamp = new Date().toISOString();

                const diff = computeDiff(oldImage?.data || oldImage, newImage.data || newImage);

                await getDocClient().send(new PutCommand({
                    TableName: process.env.TABLE_NAME,
                    Item: {
                        PK: `CHANGE#${deviceId}`,
                        SK: `${timestamp}#${eventName}#TYPE#${recordType}#${id}#${record.eventID}`,
                        changeType: eventName,
                        recordType: recordType,
                        deviceId: deviceId,
                        changeDevice: deviceId,
                        changeTimestamp: timestamp,
                        diff: diff,
                        oldSnapshot: oldImage?.data || oldImage,
                        newSnapshot: newImage.data || newImage,
                        ttl: ttl
                    }
                }));
            }
        } catch (error) {
            console.error('Error processing record:', record.eventID, error);
            batchItemFailures.push({ itemIdentifier: record.eventID });
        }
    }

    return { batchItemFailures };
}

module.exports = {
    handler,
    computeDiff
};
