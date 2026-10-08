// test only: a fresh connection for each DynamoDB call (Cloud9's temporary credentials fail on a reused connection)
const of = globalThis.fetch;
globalThis.fetch = (u, init = {}) => String(u).includes('dynamodb') ? of(u, { ...init, headers: { ...init.headers, connection: 'close' } }) : of(u, init);
