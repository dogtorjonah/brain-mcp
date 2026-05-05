import { describe, it, expect } from 'vitest';
import { createTestHomeDb, createTestEdgeEmitter } from './helpers.js';

describe('test helpers', () => {
  it('createTestHomeDb opens an in-memory database', () => {
    const db = createTestHomeDb();
    expect(db).toBeDefined();
    expect(db.db).toBeDefined();
    db.close();
  });

  it('createTestEdgeEmitter returns emitter and homeDb', () => {
    const { emitter, homeDb } = createTestEdgeEmitter();
    expect(emitter).toBeDefined();
    expect(homeDb).toBeDefined();
    homeDb.close();
  });
});
