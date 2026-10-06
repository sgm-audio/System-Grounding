const { computeDiff, handler, unmarshallDynamoDB } = require('../diffProcessor');

// Mock DynamoDB client - not needed for diffProcessor tests since it doesn't make DB calls
jest.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
        from: jest.fn().mockImplementation(() => ({
            send: jest.fn()
        }))
    },
    PutCommand: jest.fn(),
    GetCommand: jest.fn(),
    DeleteCommand: jest.fn()
}));

describe('computeDiff', () => {
    describe('INSERT events (no oldItem)', () => {
        it('should return added keys when there is no old item', () => {
            const newItem = { id: '123', name: 'Test', status: 'active' };
            const result = computeDiff(newItem, undefined);
            
            expect(result).toEqual({
                added: ['id', 'name', 'status']
            });
        });

        it('should return empty added array if newItem is empty', () => {
            const newItem = {};
            const result = computeDiff(newItem, undefined);
            
            expect(result).toEqual({
                added: []
            });
        });
    });

    describe('MODIFY events (with oldItem)', () => {
        it('should detect changed keys between old and new items', () => {
            const newItem = { id: '123', name: 'Updated Name', status: 'inactive' };
            const oldItem = { id: '123', name: 'Original Name', status: 'active' };
            
            const result = computeDiff(newItem, oldItem);
            
            expect(result).toEqual({
                changed: {
                    name: { old: 'Original Name', new: 'Updated Name' },
                    status: { old: 'active', new: 'inactive' }
                }
            });
        });

        it('should return empty changed object if nothing changed', () => {
            const newItem = { id: '123', name: 'Same', status: 'active' };
            const oldItem = { id: '123', name: 'Same', status: 'active' };
            
            const result = computeDiff(newItem, oldItem);
            
            expect(result).toEqual({
                changed: {}
            });
        });

        it('should detect when a key is removed', () => {
            const newItem = { id: '123', name: 'Test' };
            const oldItem = { id: '123', name: 'Test', extraField: 'removed' };
            
            const result = computeDiff(newItem, oldItem);
            
            expect(result.changed.extraField).toEqual({ old: 'removed', new: undefined });
        });

        it('should detect when a new key is added', () => {
            const newItem = { id: '123', name: 'Test', newField: 'added' };
            const oldItem = { id: '123', name: 'Test' };
            
            const result = computeDiff(newItem, oldItem);
            
            expect(result.changed.newField).toEqual({ old: undefined, new: 'added' });
        });

        it('should handle nested objects comparison', () => {
            const newItem = { id: '123', config: { enabled: true, count: 5 } };
            const oldItem = { id: '123', config: { enabled: false, count: 3 } };
            
            const result = computeDiff(newItem, oldItem);
            
            expect(result).toEqual({
                changed: {
                    config: { 
                        old: { enabled: false, count: 3 }, 
                        new: { enabled: true, count: 5 } 
                    }
                }
            });
        });

        it('should handle array comparison', () => {
            const newItem = { id: '123', tags: ['a', 'b', 'c'] };
            const oldItem = { id: '123', tags: ['a', 'b'] };
            
            const result = computeDiff(newItem, oldItem);
            
            expect(result.changed.tags).toEqual({ 
                old: ['a', 'b'], 
                new: ['a', 'b', 'c'] 
            });
        });
    });
});

describe('handler', () => {
    const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
    const mockConsoleError = jest.spyOn(console, 'error').mockImplementation();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        mockConsoleLog.mockRestore();
        mockConsoleError.mockRestore();
    });

    it('should process INSERT event successfully', async () => {
        const event = {
            Records: [{
                eventName: 'INSERT',
                eventID: '1',
                dynamodb: {
                    SequenceNumber: 'seq-001',
                    NewImage: {
                        id: { S: '123' },
                        name: { S: 'New Item' },
                        status: { S: 'active' }
                    }
                }
            }]
        };

        const result = await handler(event);

        expect(result).toEqual({});
        expect(mockConsoleLog).toHaveBeenCalledWith(
            'New record inserted:',
            expect.objectContaining({
                data: expect.objectContaining({ id: '123' }),
                diff: expect.objectContaining({ added: expect.any(Array) })
            })
        );
    });

    it('should process MODIFY event successfully', async () => {
        const event = {
            Records: [{
                eventName: 'MODIFY',
                eventID: '2',
                dynamodb: {
                    SequenceNumber: 'seq-002',
                    NewImage: {
                        id: { S: '123' },
                        name: { S: 'Updated' },
                        status: { S: 'inactive' }
                    },
                    OldImage: {
                        id: { S: '123' },
                        name: { S: 'Original' },
                        status: { S: 'active' }
                    }
                }
            }]
        };

        const result = await handler(event);

        expect(result).toEqual({});
        expect(mockConsoleLog).toHaveBeenCalledWith(
            'Record modified:',
            expect.objectContaining({
                diff: expect.objectContaining({ changed: expect.any(Object) })
            })
        );
    });

    it('should process REMOVE event successfully', async () => {
        const event = {
            Records: [{
                eventName: 'REMOVE',
                eventID: '3',
                dynamodb: {
                    SequenceNumber: 'seq-003',
                    OldImage: {
                        id: { S: '123' },
                        name: { S: 'Deleted Item' }
                    }
                }
            }]
        };

        const result = await handler(event);

        expect(result).toEqual({});
        expect(mockConsoleLog).toHaveBeenCalledWith(
            'Record removed:',
            expect.objectContaining({
                diff: expect.any(Object)
            })
        );
    });

    it('should collect batch item failures when processing fails', async () => {
        // Create an event that will cause an error (malformed DynamoDB image)
        const event = {
            Records: [
                {
                    eventName: 'INSERT',
                    eventID: '1',
                    dynamodb: {
                        SequenceNumber: 'seq-good',
                        NewImage: {
                            id: { S: '123' },
                            name: { S: 'Good Item' }
                        }
                    }
                },
                {
                    eventName: 'INSERT',
                    eventID: '2',
                    dynamodb: {
                        SequenceNumber: 'seq-bad',
                        NewImage: {
                            id: { S: '123' },
                            malformed: {} // Invalid AttributeValue (no type) causes an error
                        }
                    }
                }
            ]
        };

        const result = await handler(event);

        // Should have collected the failed record
        expect(result.batchItemFailures).toHaveLength(1);
        expect(result.batchItemFailures[0].itemIdentifier).toBe('seq-bad');
        
        // The good record should still be processed
        expect(mockConsoleLog).toHaveBeenCalledWith(
            'New record inserted:',
            expect.anything()
        );
    });

    it('should return empty response when all records succeed', async () => {
        const event = {
            Records: [{
                eventName: 'INSERT',
                eventID: '1',
                dynamodb: {
                    SequenceNumber: 'seq-001',
                    NewImage: {
                        id: { S: '123' },
                        name: { S: 'Test' }
                    }
                }
            }]
        };

        const result = await handler(event);

        expect(result).toEqual({});
        expect(result.batchItemFailures).toBeUndefined();
    });

    it('should handle multiple records with mixed outcomes', async () => {
        const event = {
            Records: [
                {
                    eventName: 'INSERT',
                    eventID: '1',
                    dynamodb: {
                        SequenceNumber: 'seq-001',
                        NewImage: { id: { S: '1' } }
                    }
                },
                {
                    eventName: 'MODIFY',
                    eventID: '2',
                    dynamodb: {
                        SequenceNumber: 'seq-002',
                        NewImage: { id: { S: '2' }, val: { N: '10' } },
                        OldImage: { id: { S: '2' }, val: { N: '5' } }
                    }
                },
                {
                    eventName: 'REMOVE',
                    eventID: '3',
                    dynamodb: {
                        SequenceNumber: 'seq-003',
                        OldImage: { id: { S: '3' } }
                    }
                }
            ]
        };

        const result = await handler(event);

        expect(result).toEqual({});
        expect(mockConsoleLog).toHaveBeenCalledTimes(3);
    });
});

describe('unmarshallDynamoDB', () => {
    it('should unmarshall simple string and number types', () => {
        const item = {
            id: { S: '123' },
            count: { N: '42' },
            active: { BOOL: true },
            description: { S: 'Test item' }
        };

        const result = unmarshallDynamoDB(item);

        expect(result).toEqual({
            id: '123',
            count: 42,
            active: true,
            description: 'Test item'
        });
    });

    it('should unmarshall lists', () => {
        const item = {
            tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] },
            scores: { L: [{ N: '1' }, { N: '2' }, { N: '3' }] }
        };

        const result = unmarshallDynamoDB(item);

        expect(result).toEqual({
            tags: ['a', 'b', 'c'],
            scores: [1, 2, 3]
        });
    });

    it('should unmarshall maps (nested objects)', () => {
        const item = {
            config: {
                M: {
                    enabled: { BOOL: true },
                    settings: {
                        M: {
                            timeout: { N: '30' },
                            retries: { N: '3' }
                        }
                    }
                }
            }
        };

        const result = unmarshallDynamoDB(item);

        expect(result).toEqual({
            config: {
                enabled: true,
                settings: {
                    timeout: 30,
                    retries: 3
                }
            }
        });
    });

    it('should handle NULL type', () => {
        const item = {
            id: { S: '123' },
            optionalField: { NULL: true }
        };

        const result = unmarshallDynamoDB(item);

        expect(result.optionalField).toBeNull();
    });

    it('should handle string sets and number sets', () => {
        const item = {
            categories: { SS: ['cat1', 'cat2', 'cat3'] },
            priorities: { NS: ['1', '2', '3'] }
        };

        const result = unmarshallDynamoDB(item);

        expect(result.categories).toEqual(['cat1', 'cat2', 'cat3']);
        expect(result.priorities).toEqual([1, 2, 3]);
    });
});
