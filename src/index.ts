/**
 * Host loader entry for the browser-only 工作流 (Workflow) plugin.
 *
 * The plugin contributes no host-side behaviour: every model request, response,
 * and tool execution it renders is read from the Session records the browser
 * already receives. The Node half exists so the host Loader mounts the package,
 * which is how `@deepseek-ai/dsh-client-modules` discovers the
 * `dsh.client` declaration and serves `lib/client.js` to the page.
 */

/** Provides no host-side behaviour. */
export function apply(): void {}
