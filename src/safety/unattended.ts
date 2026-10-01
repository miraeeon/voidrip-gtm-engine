/**
 * Tool capabilities that must not exist during an unattended Codex run.
 * This is enforced by the MCP server, independently of the model prompt.
 */
export const UNATTENDED_TOOL_NAMES = new Set([
  'gtm_approve',
  'gtm_launch',
  'gtm_cleanup_overloop',
  'gtm_push_to_overloop',
  'gtm_simulate_results',
  'gtm_simulate_replies',
  'gtm_manage_subscription',
  'gtm_update_icp',
  'gtm_init',
]);

export function toolAllowedInRuntime(name: string, unattended: boolean): boolean {
  return !unattended || !UNATTENDED_TOOL_NAMES.has(name);
}
