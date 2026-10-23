import assert from 'node:assert/strict';
import { parseGroupMeta, chooseTarget, routeMultiRobotMessage } from '../dist/multiRobot.js';

const extra = JSON.stringify({
  wfds: {
    broker: { type: 'robot', id: 'robot_a' },
    robots: {
      robot_a: { displayName: 'A', tags: ['coding'] },
      robot_b: { displayName: 'B', tags: ['ops'] },
    },
  },
});
const meta = parseGroupMeta(extra);
assert.equal(meta.robots.robot_b.tags[0], 'ops');
assert.equal(chooseTarget('please check ops log', meta, 'robot_a'), 'robot_b');
assert.equal(chooseTarget('please fix coding bug', meta, 'robot_a'), 'robot_a');

const sent = [];
const client = {
  async getGroupInfo() { return { result: { extra } }; },
  async sendMessage(conv, payload) { sent.push({ conv, payload }); return { isSuccess: () => true }; },
  async getMessage() { return { result: { payload: { searchableContent: 'original ops question' } } }; },
};
const base = {
  client,
  config: { robotId: 'robot_a' },
  sender: 'human',
  conv: { type: 1, target: 'g1', line: 2 },
  payload: { messageUid: 99 },
  text: 'please check ops log',
};
const owner = await routeMultiRobotMessage(base);
assert.equal(owner.handled, true);
assert.equal(owner.reason, 'owner-assigned');
assert.equal(sent.length, 1);
assert.match(sent[0].payload.content, /@B/);
assert.equal(JSON.parse(sent[0].payload.extra).wfds.targetRobotId, 'robot_b');

const guest = await routeMultiRobotMessage({ ...base, config: { robotId: 'robot_b' } });
assert.equal(guest.handled, true);
assert.equal(guest.reason, 'no-mention-guest');

const assigned = await routeMultiRobotMessage({
  ...base,
  config: { robotId: 'robot_b' },
  sender: 'robot_a',
  payload: {
    messageUid: 100,
    extra: JSON.stringify({ wfds: { op: 'assign', targetRobotId: 'robot_b', messageUid: 99, note: '优先看 20:15' } }),
  },
  text: '@B 这条请你处理',
});
assert.equal(assigned.handled, false);
assert.equal(assigned.force, true);
assert.equal(assigned.bypassWhitelist, true);
assert.match(assigned.text, /original ops question/);
assert.match(assigned.text, /优先看 20:15/);

console.log('multi-robot routing tests passed');
