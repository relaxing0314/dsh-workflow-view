/**
 * Ambient declarations for the platform modules this browser bundle requests.
 *
 * This file must stay a **script** (no top-level `import`/`export`): a single
 * export would turn every `declare module` below into a module augmentation
 * that only resolves when the real package is installed. The plugin is authored
 * outside the DSH checkout, so these declarations are the whole type surface for
 * the runtime modules it requires from the loader's module table.
 */

declare module 'react' {
  export type ReactNode = unknown
  export type FC<P = Record<string, unknown>> = (props: P) => ReactNode
  export interface MutableRefObject<T> { current: T }
  export interface CSSProperties { [key: string]: string | number | undefined }

  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactNode
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  export function useRef<T>(initial: T): MutableRefObject<T>
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useSyncExternalStore<S>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => S,
  ): S
  export function memo<P>(component: (props: P) => ReactNode): (props: P) => ReactNode
}

declare module 'react/jsx-runtime' {
  /** Automatic-runtime JSX surface; the bundle never needs type-level fidelity here. */
  export const Fragment: unique symbol
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown
  export namespace JSX {
    type Element = unknown
    interface ElementChildrenAttribute { children: Record<string, never> }
    /** Accepts the standard `key` / `ref` seats on intrinsic and component elements. */
    interface IntrinsicAttributes { key?: string | number }
    interface IntrinsicClassAttributes<T> { ref?: T }
    interface IntrinsicElements { [name: string]: Record<string, unknown> }
  }
}

declare module '@deepseek-ai/cordis' {
  /** Cordis context face: only the members this plugin touches. */
  export interface Context {
    get(name: string): unknown
    effect(callback: () => (() => void) | void, label?: string): () => void
    on(name: string, listener: (...args: never[]) => unknown): () => void
  }
}

declare module '*.css' {
  const text: string
  export default text
}
