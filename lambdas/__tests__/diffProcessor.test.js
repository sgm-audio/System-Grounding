// Tests for the deployed diff processor contract (see lambdas/diffProcessor.js,
// kept in sync with the inline ZipFile in template.yaml).
jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: jest.fn(() => ({ send: mockSend }))
    },
    PutCommand: jest.fn((params) => params)
}));

const { handler, computeDiff } = require('../diffProcessor');

// DynamoDB Streams deliver images as AttributeValue maps
const av = {
    str: (v) => ({ S: v }),
    map: (obj) => ({
        M: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, av.str(v)]))
    })
};

function image(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k] = typeof v === 'object' && v !== null ? av.map(v) : av.str(v);
    }
    return out;
}

function streamEvent(records) {
    return { Records: records };
}

beforeAll(() => {
    process.env.TABLE_NAME = 'SystemState';
    process.env.TTL_DAYS = '7';
});

beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
});

describe('computeDiff', () => {
    it('detects changed keys between old and new data', () => {
        const diff = computeDiff({ name: 'a', status: 'active' }, { name: 'a', status: 'inactive' });
        expect(diff).toEqual({ status: { old: 'active', new: 'inactive' } });
    });

    it('reports added keys', () => {
        const diff = computeDiff({}, { name: 'a' });
        expect(diff).toEqual({ name: { old: undefined, new: 'a' } });
    });

    it('reports removed keys', () => {
        const diff = computeDiff({ name: 'a', extra: 'gone' }, { name: 'a' });
        expect(diff.extra).toEqual({ old: 'gone', new: undefined });
    });

    it('returns an empty diff when nothing changed', () => {
        expect(computeDiff({ a: '1' }, { a: '1' })).toEqual({});
    });

    it('handles a missing old object (INSERT)', () => {
        expect(computeDiff(undefined, { a: '1' })).toEqual({ a: { old: undefined, new: '1' } });
    });
});

describe('stream handler', () => {
    it('writes a CHANGE# record for INSERT events using unmarshalled values', async () => {
        const before = Math.floor(Date.now() / 1000);
        const event = streamEvent([{
            eventName: 'INSERT',
            eventID: 'evt-1',
            dynamodb: {
                NewImage: image({
                    PK: 'DEVICE#framework-13',
                    SK: 'TYPE#SERVICE#sshd.service',
                    deviceId: 'framework-13',
                    recordType: 'SERVICE',
                    id: 'sshd.service',
                    data: { name: 'sshd.service', status: 'active' }
                })
            }
        }]);

        const result = await handler(event);

        expect(result).toEqual({ batchItemFailures: [] });
        expect(mockSend).toHaveBeenCalledTimes(1);
        const put = mockSend.mock.calls[0][0];
        expect(put.TableName).toBe('SystemState');
        // PK must use the plain device id, not an AttributeValue object
        expect(put.Item.PK).toBe('CHANGE#framework-13');
        expect(put.Item.SK).toContain('#INSERT#TYPE#SERVICE#sshd.service#evt-1');
        expect(put.Item.changeType).toBe('INSERT');
        expect(put.Item.changeDevice).toBe('framework-13');
        expect(put.Item.newSnapshot).toEqual({ name: 'sshd.service', status: 'active' });
        // TTL: 7 days (TTL_DAYS env)
        expect(put.Item.ttl).toBeGreaterThanOrEqual(before + 7 * 86400);
        expect(put.Item.ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7 * 86400 + 5);
    });

    it('computes a diff from the data attribute on MODIFY events', async () => {
        const event = streamEvent([{
            eventName: 'MODIFY',
            eventID: 'evt-2',
            dynamodb: {
                OldImage: image({
                    deviceId: 'framework-13',
                    recordType: 'SERVICE',
                    id: 'sshd.service',
                    data: { name: 'sshd.service', status: 'active' }
                }),
                NewImage: image({
                    deviceId: 'framework-13',
                    recordType: 'SERVICE',
                    id: 'sshd.service',
                    data: { name: 'sshd.service', status: 'inactive' }
                })
            }
        }]);

        const result = await handler(event);

        expect(result).toEqual({ batchItemFailures: [] });
        const put = mockSend.mock.calls[0][0];
        expect(put.Item.changeType).toBe('MODIFY');
        expect(put.Item.SK).toContain('#MODIFY#TYPE#SERVICE#sshd.service#evt-2');
        expect(put.Item.diff).toEqual({ status: { old: 'active', new: 'inactive' } });
        expect(put.Item.oldSnapshot).toEqual({ name: 'sshd.service', status: 'active' });
        expect(put.Item.newSnapshot).toEqual({ name: 'sshd.service', status: 'inactive' });
    });

    it('writes a DELETE CHANGE# record for REMOVE events', async () => {
        const event = streamEvent([{
            eventName: 'REMOVE',
            eventID: 'evt-3',
            dynamodb: {
                OldImage: image({
                    deviceId: 'framework-13',
                    recordType: 'ENV',
                    id: 'HOME',
                    data: { key: 'HOME', value: '/home/x' }
                })
            }
        }]);

        const result = await handler(event);

        expect(result).toEqual({ batchItemFailures: [] });
        const put = mockSend.mock.calls[0][0];
        expect(put.Item.PK).toBe('CHANGE#framework-13');
        expect(put.Item.SK).toContain('#DELETE#TYPE#ENV#HOME#evt-3');
        expect(put.Item.changeType).toBe('DELETE');
        expect(put.Item.oldSnapshot).toEqual({ key: 'HOME', value: '/home/x' });
        expect(put.Item.newSnapshot).toBeUndefined();
    });

    it('skips INSERT records without a NewImage without failing the batch', async () => {
        const event = streamEvent([{
            eventName: 'INSERT',
            eventID: 'evt-4',
            dynamodb: { NewImage: null }
        }]);

        const result = await handler(event);

        expect(result).toEqual({ batchItemFailures: [] });
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('reports per-record failures via batchItemFailures and keeps processing', async () => {
        mockSend.mockRejectedValueOnce(new Error('simulated DynamoDB outage'));

        const makeRecord = (id) => ({
            eventName: 'INSERT',
            eventID: id,
            dynamodb: {
                NewImage: image({ deviceId: 'd1', recordType: 'PACKAGE', id, data: { name: id } })
            }
        });

        const result = await handler(streamEvent([makeRecord('a'), makeRecord('b')]));

        expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'a' }]);
        // The second record was still processed
        expect(mockSend).toHaveBeenCalledTimes(2);
    });
});
