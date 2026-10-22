import { unreadOverview } from '../../chatlog/query.js';

export const op = 'unread';

export function run({ poolFor }, convKey) {
  return unreadOverview(poolFor(convKey));
}
