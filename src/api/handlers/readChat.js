import { readChat } from '../../chatlog/query.js';

export const op = 'readChat';

export function run({ poolFor }, convKey, args) {
  return readChat(poolFor(convKey), args);
}
