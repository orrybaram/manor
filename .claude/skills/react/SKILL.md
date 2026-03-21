---
name: react
description: React component patterns and best practices for this codebase. Use when writing or reviewing React components (*.tsx files).
---

# React Patterns

Core principle: **Prefer declarative patterns and cleanup all side effects.**

## useEffect

**`useEffect` is banned.** Never call it directly — see [useEffect.md](useEffect.md) for all replacement patterns. For mount-only external sync, use `useMountEffect`.

## When to Use

- Writing new React components (\*.tsx)
- Reviewing PR changes to components
- Debugging state sync or effect issues

## Quick Reference

| Pattern              | Do                                            | Don't                              |
| -------------------- | --------------------------------------------- | ---------------------------------- |
| Side effects         | `useMountEffect` for mount-only external sync | Direct `useEffect`                 |
| DOM node setup       | Ref callbacks (with cleanup in React 19)      | `useMountEffect` + `useRef`        |
| Derived state        | Compute inline or with `useMemo`              | Sync state in useEffect            |
| User actions         | Event handlers                                | Effect as action relay             |
| Reset on ID change   | `key` prop to force remount                   | Effect with dependency             |
| Partial state reset  | Derive from props (store ID, not object)      | Effect to null out state on change |
| Browser APIs         | Use `useSyncExternalStore`                    | useEffect + setState               |
| Shared handler logic | Extract helper, call from each handler        | Effect watching derived state      |
| Computation chains   | Calculate all next state in one handler       | Effect A → B → C cascade           |
| Notify parent        | Call callback in the event handler            | Effect watching local state        |
| Child-to-parent data | Lift fetching to parent, pass as prop         | Effect + onFetched callback        |
| Expensive filtering  | Use `useDeferredValue`                        | Block typing with computation      |


## Component Props
- Use `type` (not `interface`) for component props
- Name the parameter `props`, destructure on the first line of the component body
- Add a blank line after the props destructuring before the rest of the component logic

```tsx
// ✅ Good
type MyComponentProps = {
  title: string;
  count: number;
};

function MyComponent(props: MyComponentProps) {
  const { title, count } = props;

  return <Text>{title}: {count}</Text>;
}

// ❌ Bad: inline destructuring in parameter
function MyComponent({ title, count }: MyComponentProps) {
  return <Text>{title}: {count}</Text>;
}
```

## Compound Components

- Use Context over `cloneElement` for sharing implicit state
- Create guarded context hooks that throw outside provider
- Memoize provider value (`useMemo`) and keep actions stable (`useCallback`)

## Dependency Arrays

Never include React-guaranteed stable values (`useState` setters, `useReducer` dispatch, `useRef` objects) in dependency arrays.

## Common Mistakes

| Mistake                            | Fix                                                       |
| ---------------------------------- | --------------------------------------------------------- |
| Direct `useEffect` call            | See [useEffect.md](useEffect.md) for replacement patterns |
| useEffect to sync derived state    | Compute inline or with `useMemo`                          |
| useEffect to reset on ID change    | Use `key` prop to force remount                           |
| useEffect to reset partial state   | Store an ID, derive the object from props                 |
| useEffect chain (A → B → C)        | Calculate all next state in one event handler             |
| useEffect to notify parent         | Call parent callback in the same event handler            |
| useEffect to push data to parent   | Lift fetching to parent, pass data down as prop           |
| useEffect for shared handler logic | Extract helper function, call from each handler           |
| Redundant useState                 | Derive state from existing state                          |

### Redundant State

When one piece of state can be computed from another, don't use two `useState` calls. Instead, derive the value:

```tsx
// ❌ Bad: two states that must stay in sync
const [selectedItem, setSelectedItem] = useState<Item | null>(null);
const [page, setPage] = useState<'list' | 'detail'>('list');

// ✅ Good: derive page from selectedItem
const [selectedItem, setSelectedItem] = useState<Item | null>(null);
const page = selectedItem ? 'detail' : 'list';
```
