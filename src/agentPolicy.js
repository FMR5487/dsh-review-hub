/**
 * Per-agent narrowing: the same tool may be auto-decided in a session a human is
 * watching, and must not be in one nobody is watching.
 *
 * Anything we cannot positively identify becomes 'unknown', and 'unknown' is as
 * strict as the strictest known kind — guessing permissively is the failure mode
 * this file exists to prevent.
 */

export const AGENT_KINDS = Object.freeze(['default', 'subagent', 'scheduled', 'task_board', 'unknown']);

/** ai ceiling per requester kind: full | strict | off */
export const DEFAULT_AGENT_POLICY = Object.freeze({
	default: 'full',
	subagent: 'strict',
	scheduled: 'strict',
	task_board: 'strict',
	unknown: 'strict',
});

/**
 * Which kind of requester this is. Field names are read defensively: the agent
 * object is host-owned and not a wire type.
 */
export function classifyAgent(agent) {
	if (agent === null || typeof agent !== 'object') return 'unknown';
	for (const key of ['origin', 'source', 'kind', 'role']) {
		const value = agent[key];
		if (typeof value !== 'string') continue;
		if (/^(subagent|delegate|teammate)$/i.test(value)) return 'subagent';
		if (/^(schedule|scheduled|cron|timer)$/i.test(value)) return 'scheduled';
		if (/^(task[-_]?board|task[-_]?card)$/i.test(value)) return 'task_board';
	}
	if (agent.taskBoardTaskId !== undefined || agent.cardId !== undefined) return 'task_board';
	if (agent.scheduleId !== undefined || agent.cron !== undefined) return 'scheduled';
	if (agent.parent !== undefined && agent.parent !== null) return 'subagent';
	if (agent.parentAgentId !== undefined || agent.subagentOf !== undefined || agent.isSubagent === true) return 'subagent';
	if (typeof agent.id === 'string') {
		if (/:sub:/i.test(agent.id)) return 'subagent';
		if (/:task:/i.test(agent.id)) return 'task_board';
		if (/:schedule:/i.test(agent.id)) return 'scheduled';
	}
	return 'default';
}

/** Clamp one tier by the agent kind's ceiling. */
export function clampByAgent(tier, agentKind, policy) {
	if (tier !== 'ai') return tier;
	const table = policy ?? DEFAULT_AGENT_POLICY;
	const level = table?.[agentKind] ?? table?.unknown ?? 'strict';
	return level === 'full' ? 'ai' : 'human';
}
