import { testToolName } from './test-tool.mjs';

export function grade(spec, events, changed) {
  const isEdit = (event) => ['edit', 'write'].includes(event.toolName);
  const completed = (event, name) =>
    event.type === 'tool_execution_end' && event.toolName === name && !event.isError;
  const lastAnswer = events.findLastIndex(
    (event) =>
      event.type === 'message_end' &&
      event.message?.role === 'assistant' &&
      event.message.content?.some((part) => part.type === 'text'),
  );
  const resultAt = events.findIndex((event) => completed(event, 'ei_impact'));
  if (resultAt < 0) return 'no successful impact call';
  if (lastAnswer <= resultAt) return 'no final answer after impact';

  const impact = events.findIndex(
    (event) =>
      event.type === 'tool_execution_start' && event.toolCallId === events[resultAt].toolCallId,
  );
  const result = events[resultAt].result?.details?.[0];
  const action = result?.verdict?.action;
  const edits = events.findIndex((event) => event.type === 'tool_execution_start' && isEdit(event));
  const lastEdit = events.findLastIndex(
    (event) => event.type === 'tool_execution_end' && isEdit(event) && !event.isError,
  );
  if (
    spec.search &&
    (impact < 0 || !events.slice(0, impact).some((event) => completed(event, 'ei_search')))
  )
    return 'no search before impact';
  if (spec.blocked && (action !== 'ask-owner' || edits >= 0 || changed))
    return 'ask-owner not respected';
  if (!spec.edit && (changed || edits >= 0)) return 'unexpected edit';
  if (spec.edit && (!changed || edits <= resultAt || lastEdit >= lastAnswer || lastEdit < 0))
    return 'no edit after impact';

  const next = events.slice(Math.max(lastEdit, resultAt) + 1, lastAnswer);
  const changes = next.findLast((event) => completed(event, 'ei_changes'));
  if ((spec.edit || spec.changes) && !changes) return 'no changes result before final answer';
  const changeAction = changes?.result?.details?.verdict?.action;
  if (spec.edit && action === 'ask-owner') return 'edited despite ask-owner';
  if (spec.edit && (action === 'run-tests' || changeAction === 'run-tests')) {
    const verified = next.some(
      (event) => completed(event, testToolName) && event.result?.details?.passed === true,
    );
    if (!verified) return 'run-tests not verified in transcript';
  }
  if (spec.path && !spec.blocked && result?.code !== 'target-not-found')
    return 'expected outside-scope guidance';
  return null;
}
