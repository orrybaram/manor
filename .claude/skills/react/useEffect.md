# useEffect Ban

**Never call `useEffect` directly.** For mount-only external sync, use `useMountEffect`.

## Why

- **Brittleness:** Dependency arrays hide coupling — unrelated refactors quietly change effect behavior.
- **Infinite loops:** State update → render → effect → state update loops are easy to create and hard to spot.
- **Dependency hell:** Effect chains (A sets state that triggers B) are time-based control flow — hard to trace, easy to regress.
- **Debugging pain:** "Why did this run?" has no clear entrypoint like a handler.

This matters even more with agents writing code. `useEffect` gets added "just in case," but that move seeds the next race condition or infinite loop. Banning it forces logic to be declarative and predictable.

See also: [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect).

## Replacement Patterns

### 1. Derive state inline

```tsx
// ❌ BAD: Extra render cycle
const [products, setProducts] = useState([]);
const [filtered, setFiltered] = useState([]);
useEffect(() => {
  setFiltered(products.filter((p) => p.inStock));
}, [products]);

// ✅ GOOD: Compute inline
const filtered = products.filter((p) => p.inStock);
```

If expensive, use `useMemo`:

```tsx
// ❌ BAD: Effect to cache computation
useEffect(() => {
  setVisibleTodos(getFilteredTodos(todos, filter));
}, [todos, filter]);

// ✅ GOOD: useMemo recalculates only when deps change
const visibleTodos = useMemo(
  () => getFilteredTodos(todos, filter),
  [todos, filter],
);
```

#### Adjust partial state on prop change

Don't reset part of state via effect — derive it:

```tsx
// ❌ BAD: Effect clears selection when items change
useEffect(() => {
  setSelection(null);
}, [items]);

// ✅ GOOD: Store an ID, derive the object — stale selection auto-clears
const [selectedId, setSelectedId] = useState<string | null>(null);
const selection = items.find((item) => item.id === selectedId) ?? null;
```

### 2. Event handlers for user-triggered actions

```tsx
// ❌ BAD: State flag → effect relay
const [liked, setLiked] = useState(false);
useEffect(() => {
  if (liked) {
    postLike();
    setLiked(false);
  }
}, [liked]);
return <button onClick={() => setLiked(true)}>Like</button>;

// ✅ GOOD: Direct handler
return <button onClick={() => postLike()}>Like</button>;
```

**Smell test:** State is used as a flag so an effect can do the real action.

### 3. `useMountEffect` for one-time external sync

`useMountEffect` wraps `useEffect(..., [])` with explicit naming.

```tsx
import { useMountEffect } from "@/hooks/useMountEffect";

function Widget() {
  useMountEffect(() => {
    thirdPartyLib.init(ref.current);
    return () => thirdPartyLib.destroy();
  });
}
```

**Good uses:** DOM integration (focus, scroll), third-party widget lifecycles, browser API subscriptions.

#### Conditional mounting

Don't guard inside an effect — mount only when preconditions are met:

```tsx
// ❌ BAD: Guard inside effect
function VideoPlayer({ isLoading }) {
  useEffect(() => {
    if (!isLoading) playVideo();
  }, [isLoading]);
}

// ✅ GOOD: Mount only when preconditions are met
function Wrapper({ isLoading }) {
  if (isLoading) return <Loading />;
  return <VideoPlayer />;
}
function VideoPlayer() {
  useMountEffect(() => playVideo());
}
```

### 4. Ref callbacks for DOM node setup/teardown

For work scoped to a specific DOM node, prefer a ref callback over `useMountEffect` + `useRef`. React 19 ref callbacks can return a cleanup function:

```tsx
// ❌ BAD
const ref = useRef<HTMLDivElement>(null);
useMountEffect(() => {
  const observer = new ResizeObserver(([entry]) =>
    setHeight(entry.contentRect.height),
  );
  observer.observe(ref.current!);
  return () => observer.disconnect();
});
return <div ref={ref} />;

// ✅ GOOD: ref callback with cleanup
const measuredRef = (node: HTMLDivElement) => {
  const observer = new ResizeObserver(([entry]) =>
    setHeight(entry.contentRect.height),
  );
  observer.observe(node);
  return () => observer.disconnect();
};
return <div ref={measuredRef} />;
```

When a ref callback has no deps on component state/props, extract it outside the component for stability:

```tsx
function scrollIntoView(node: HTMLElement) {
  node.scrollIntoView({ behavior: "smooth" });
}
// usage: <input ref={scrollIntoView} />
```

**Smell test:** If the size change is always caused by a user action (typing, submitting), measure in the event handler instead — an observer is the wrong abstraction when you already know _when_ the change happens.

**When to use:** DOM measurement, `ResizeObserver`/`IntersectionObserver`, third-party lib init on a specific element, scroll/focus on mount. Prefer ref callbacks when the work is scoped to a single DOM node. Use `useMountEffect` for setup that doesn't target a specific element (e.g., global event listeners, non-DOM initialization).

### 5. `key` prop to force remount

When the requirement is "start fresh when ID changes," use React's remount semantics:

```tsx
// ❌ BAD: Effect resets on ID change
useEffect(() => {
  loadVideo(videoId);
}, [videoId]);

// ✅ GOOD: key forces clean remount
<VideoPlayer key={videoId} videoId={videoId} />;
// Inside VideoPlayer: useMountEffect(() => loadVideo(videoId));
```

### 6. `useSyncExternalStore` for external subscriptions

```tsx
// ❌ BAD: Manual subscription
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return isOnline;
}

// ✅ GOOD: Purpose-built hook
function useOnlineStatus() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
```

### 7. Shared logic between event handlers

Extract a helper — don't watch derived state with an effect:

```tsx
// ❌ BAD: Effect fires notification on cart state change
useEffect(() => {
  if (product.isInCart) showNotification(`Added ${product.name} to cart!`);
}, [product]);

// ✅ GOOD: Shared function called from each handler
function buyProduct() {
  addToCart(product);
  showNotification(`Added ${product.name} to cart!`);
}
function handleBuyClick() {
  buyProduct();
}
function handleCheckoutClick() {
  buyProduct();
  navigateTo("/checkout");
}
```

**Smell test:** The effect fires on a state change that was always caused by a user action.

### 8. Chains of computations

Effect chains (A → B → C) cause cascading renders and are fragile:

```tsx
// ❌ BAD: 3 chained effects, 4 renders
useEffect(() => {
  if (card?.gold) setGoldCardCount((c) => c + 1);
}, [card]);
useEffect(() => {
  if (goldCardCount > 3) {
    setRound((r) => r + 1);
    setGoldCardCount(0);
  }
}, [goldCardCount]);
useEffect(() => {
  if (round > 5) setIsGameOver(true);
}, [round]);

// ✅ GOOD: All next state in one handler, derive what you can
const isGameOver = round > 5;

function handlePlaceCard(nextCard: Card) {
  setCard(nextCard);
  if (!nextCard.gold) return;
  if (goldCardCount < 3) {
    setGoldCardCount(goldCardCount + 1);
  } else {
    setGoldCardCount(0);
    setRound(round + 1);
  }
}
```

### 9. Notifying parent components

Call the parent callback in the same handler — don't sync via effect:

```tsx
// ❌ BAD: Effect watches local state
useEffect(() => {
  onChange(isOn);
}, [isOn, onChange]);

// ✅ GOOD: Notify in the handler
function handleClick() {
  const nextIsOn = !isOn;
  setIsOn(nextIsOn);
  onChange(nextIsOn);
}
```

Even better — make it a controlled component and lift state to the parent.

### 10. Passing data to the parent

Data flows down. Don't fetch in a child and push up via effect — fetch in the parent:

```tsx
// ❌ BAD: Child fetches, pushes up
function Parent() {
  const [data, setData] = useState(null);
  return <Child onFetched={setData} />;
}
function Child(props: ChildProps) {
  const data = useSomeAPI();
  useEffect(() => {
    if (data) props.onFetched(data);
  }, [props.onFetched, data]);
}

// ✅ GOOD: Parent owns the data
function Parent() {
  const data = useSomeAPI();
  return <Child data={data} />;
}
```

## `useMountEffect` Locations

- `apps/web/src/hooks/useMountEffect.ts`
- `apps/extension/src/common/hooks/useMountEffect.ts`
- `apps/aura/src/hooks/useMountEffect.ts`
