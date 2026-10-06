// Tests for the deployed ingest contract (see lambdas/ingestApi.js, kept in
// sync with the inline ZipFile in template.yaml).
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

const { handler } = require('../ingestApi');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function postEvent(body) {
    return { httpMethod: 'POST', body };
}

beforeAll(() => {
    process.env.TABLE_NAME = 'SystemState';
});

beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
});

describe('CORS / preflight', () => {
    it('answers OPTIONS preflight with 200 and CORS headers', async () => {
        const result = await handler({ httpMethod: 'OPTIONS', body: null });
        expect(result.statusCode).toBe(200);
        expect(result.headers).toEqual(CORS_HEADERS);
        expect(result.body).toBe('');
    });

    it('includes CORS headers on error responses', async () => {
        const result = await handler(postEvent('not json'));
        expect(result.headers).toEqual(CORS_HEADERS);
    });
});

describe('request validation', () => {
    it('returns 400 for malformed JSON', async () => {
        const result = await handler(postEvent('{not valid json'));
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body)).toEqual({ error: 'Invalid JSON in request body' });
    });

    it('returns 400 for an empty body', async () => {
        const result = await handler(postEvent(''));
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).error).toBe('Invalid JSON in request body');
    });

    it('returns 400 when the body is null (JSON "null")', async () => {
        const result = await handler(postEvent('null'));
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body).error).toBe('Invalid request. Requires deviceId and records array.');
    });

    it('returns 400 when deviceId is missing', async () => {
        const result = await handler(postEvent(JSON.stringify({ records: [] })));
        expect(result.statusCode).toBe(400);
    });

    it('returns 400 when records is not an array', async () => {
        const result = await handler(postEvent(JSON.stringify({ deviceId: 'd1', records: 'nope' })));
        expect(result.statusCode).toBe(400);
    });
});

describe('successful ingestion', () => {
    it('writes each record as a DEVICE#/TYPE# item with TTL and freshness metadata', async () => {
        const body = {
            deviceId: 'framework-13',
            records: [
                { recordType: 'SERVICE', id: 'sshd.service', data: { name: 'sshd.service', status: 'active' }, stalenessThresholdSeconds: 300 },
                { recordType: 'PACKAGE', id: 'curl', data: { name: 'curl', version: '8.0' } }
            ]
        };
        const before = Math.floor(Date.now() / 1000);

        const result = await handler(postEvent(JSON.stringify(body)));
        const after = Math.floor(Date.now() / 1000);

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body)).toEqual({
            success: true,
            results: [
                { recordType: 'SERVICE', id: 'sshd.service', status: 'success' },
                { recordType: 'PACKAGE', id: 'curl', status: 'success' }
            ]
        });

        expect(mockSend).toHaveBeenCalledTimes(2);

        const [servicePut, packagePut] = mockSend.mock.calls.map((call) => call[0]);

        expect(servicePut.TableName).toBe('SystemState');
        expect(servicePut.Item.PK).toBe('DEVICE#framework-13');
        expect(servicePut.Item.SK).toBe('TYPE#SERVICE#sshd.service');
        expect(servicePut.Item.recordType).toBe('SERVICE');
        expect(servicePut.Item.deviceId).toBe('framework-13');
        expect(servicePut.Item.data).toEqual({ name: 'sshd.service', status: 'active' });
        expect(servicePut.Item.stalenessThresholdSeconds).toBe(300);
        // TTL honors the per-record staleness threshold
        expect(servicePut.Item.ttl).toBeGreaterThanOrEqual(before + 300);
        expect(servicePut.Item.ttl).toBeLessThanOrEqual(after + 300);
        // lastCollected is an ISO timestamp
        expect(new Date(servicePut.Item.lastCollected).toISOString()).toBe(servicePut.Item.lastCollected);

        // Default staleness (86400) applies when the record omits it
        expect(packagePut.Item.SK).toBe('TYPE#PACKAGE#curl');
        expect(packagePut.Item.stalenessThresholdSeconds).toBe(86400);
        expect(packagePut.Item.ttl).toBeGreaterThanOrEqual(before + 86400);
        expect(packagePut.Item.ttl).toBeLessThanOrEqual(after + 86400);
    });

    it('returns 200 with an empty results list for an empty records array', async () => {
        const result = await handler(postEvent(JSON.stringify({ deviceId: 'd1', records: [] })));
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ success: true, results: [] });
        expect(mockSend).not.toHaveBeenCalled();
    });
});

describe('error handling', () => {
    it('returns 500 without leaking internal error details when DynamoDB fails', async () => {
        mockSend.mockRejectedValue(new Error('simulated DynamoDB outage'));

        const body = { deviceId: 'd1', records: [{ recordType: 'ENV', id: 'HOME', data: { value: '/home/x' } }] };
        const result = await handler(postEvent(JSON.stringify(body)));

        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body)).toEqual({ error: 'Internal server error' });
    });
});
