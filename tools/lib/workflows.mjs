// Which GitHub Actions workflows count as a repo's CI.
//
// Dependabot's security/version-update jobs show up in the workflow list as
// "Dependabot Updates" (path dynamic/dependabot/dependabot-updates). They fail
// whenever a transitive fix can't be resolved, which says nothing about the
// repo's own CI — and counting them blocked release trains and inflated the
// failing-workflow figures. Every GitHub-managed "dynamic/..." workflow is skipped.

export const isRepoCi = workflow => workflow.state === 'active' && !String(workflow.path ?? '').startsWith('dynamic/');

// Map of workflow id → name for the workflows that count as the repo's own CI.
export const repoCiWorkflows = workflows => new Map(workflows.filter(isRepoCi).map(w => [w.id, w.name]));
