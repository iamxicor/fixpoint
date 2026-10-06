# Fix recipes (the allow-list)

Fixpoint applies exactly one of these per pull request. Anything outside this list is out of scope for the agent: business logic, data-fetching semantics, navigation structure, styling. Every recipe lists *when* it applies, *how* to apply it, its *risk*, and the *evidence required* before and after. The verdict decides; the recipe only proposes.

Finding kinds that suggest each recipe are in parentheses. Ids are the values of `suggestedFixes` in `findings.json`.

---

## 1. `remove-compiler-bailout` — remove a React Compiler bailout cause (compiler-bailout, wasted-render, hot-component)

**When.** The React Compiler skipped a component or hook (`compiler-bailout` finding with the reason), and the same component shows up in a render finding. Common causes in the reference app: reading `ref.current` during render, writing a Reanimated shared value during render, mutating a value captured by a `runOnJS` callback, reassigning a module-level variable inside the function.

**How.** Fix the cause, not the symptom: move the ref read into an effect or event handler; move the shared-value write into `useAnimatedReaction`/an effect; make the mutated binding a local or a ref; split the function so the offending part is not a component or hook. Re-run the compiler pass (`fixpoint scan` does) and confirm the function no longer appears in `compiler-bailouts.json`.

**Risk.** Low to medium. Changing when a ref is read can change behaviour if the ref was intentionally read during render (rare and already a bug). Never add `"use no memo"`; that is the opposite of this recipe.

**Evidence required.** Before: the bailout entry plus the render finding. After: the bailout is gone and the A/B shows `componentRenders` or `avoidableRenders` down with every pair agreeing.

---

## 2. `stable-row-props` — stable row props and a memo boundary for list cells (wasted-render, render-fanout)

**When.** `wasted-render` on a list row (or "X via Row") with `callbackOnlyRenders` or `deepEqualRenders` dominating; `render-fanout` whose commits are mostly `CellRenderer`/`VirtualizedListCellContextProvider` rows. The row receives a new `onPress`/`style`/`item` identity on every parent render.

**How.** In the list owner: memoise `renderItem` and the callbacks it closes over (`useCallback`), hoist static style objects, pass primitive ids instead of fresh objects, derive per-row data with `useMemo` keyed by the data array. In the row: wrap in `React.memo` if the compiler does not already compile it (check `compiler-bailouts.json`); compare primitives, not objects.

**Risk.** Low. A stale closure can appear if a memoised callback captures state it should read from props; prefer reading from the row's own props.

**Evidence required.** `avoidableRenders` for the row component drops to near zero in every pair; `componentRenders` for the screen drops by at least the row count per scroll.

---

## 3. `move-state-down` — move state down or split a context that fans out (render-fanout, wasted-render)

**When.** `render-fanout` whose trigger (`evidence.commits[].trigger`) is a `setState`/`updateSyncExternalStore` in an ancestor far above the components that actually use the value, or a context provider whose value object changes identity on every render (`changedProps` shows `value`). Cascading updates in the same component strengthen the case.

**How.** Move the state into the smallest subtree that reads it; or split the context into one for stable values and one for the changing value; or memoise the provider value (`useMemo` on the object) so consumers with unchanged slices skip. Do not change what the state means.

**Risk.** Medium. Moving state changes which components re-mount on route changes; keep the state's lifetime identical (same owner lifetime or lift to a store).

**Evidence required.** `componentsPerCommit` for the root drops in every pair; the trigger component's commits shrink; no new cascading updates.

---

## 4. `lazy-require` — lazy-require a module initialised at startup but not used by the first screen (startup-critical-path, long-task)

**When.** `routeModulesInitializedEagerly` lists routes other than the first screen, or a `long-task` whose frames are module factories (`metroRequire`, `loadModuleImplementation`) at startup, or `topPackages` shows a heavy package the first screen does not render.

**How.** Replace the static import in the layout or shared module with a lazy one: `React.lazy` for screens that are not the initial route, `require()` inside the handler that needs the module, or Expo Router's lazy route loading. Keep the public exports of the module unchanged.

**Risk.** Low to medium. A lazily loaded module shifts its initialisation cost to first use; make sure the first use is not on a gesture-critical path. Side-effect imports (polyfills, global registrations) must stay eager.

**Evidence required.** `modulesInitializedBeforeFirstScreen` drops by the module count of the lazy subtree in every cold launch; no new `long-task` on the screen that now loads the module.

---

## 5. `list-config` — FlashList / FlatList configuration (hot-component, frame-drop, long-task)

**When.** `hot-component` or `frame-drop` during the scroll window with frames inside `VirtualizedList`/`FlashList` internals, rows with wildly different heights without `getItemType`, or `renderItem` created inline. Missing `estimatedItemSize` (FlashList 1), missing `getItemType`, `keyExtractor` not stable, `initialNumToRender`/`windowSize` left at defaults on a long list.

**How.** Set `getItemType` for heterogeneous rows, provide a stable `keyExtractor`, hoist `renderItem`, set `maxToRenderPerBatch`/`windowSize`/`initialNumToRender` to the values the screen needs, use `removeClippedSubviews` only where it is known to be safe. For FlashList 2, keep `renderItem` and `keyExtractor` identities stable and make rows memo-friendly (recipe 2).

**Risk.** Low. Wrong `getItemType` causes recycling glitches (a cell shows the wrong layout); verify visually with the pixel gate and by scrolling both directions.

**Evidence required.** `framesOverBudget` and `longestTaskMs` down with the CI excluding zero, `componentRenders` not up.

---

## 6. `hoist-literals` — hoist inline object, array and style literals where the compiler bailed (wasted-render, hot-component, compiler-bailout)

**When.** `wasted-render` with `deepEqualRenders` (a `style`, `contentContainerStyle`, `data`, `params` prop that is deeply equal but new on every render) in a component the compiler skipped, or when the owner is not compiled.

**How.** Move static literals to module scope or `StyleSheet.create`; wrap computed ones in `useMemo` with the right dependencies; replace inline arrow callbacks with `useCallback` when they are passed to memoised children. Do not change the values.

**Risk.** Low. Missing dependencies in `useMemo`/`useCallback` produce stale values; include every captured variable.

**Evidence required.** `deepEqualRenders` for the component drops to zero in every pair.

---

## 7. `remove-redundant-effect` — remove an effect that causes a redundant second commit (wasted-render with `cascadingUpdates`)

**When.** `cascadingUpdates` for a component: an effect calls `setState` immediately after a commit to derive a value from props or state that was already available during render.

**How.** Derive the value during render (plain computation or `useMemo`) or use the "adjust state during render" pattern (`if (prev !== next) setState(next)` guarded by a previous-value state). Keep the resulting value identical.

**Risk.** Low to medium. Effects that also synchronise with a non-React system (subscriptions, native modules) must keep that part; only the state derivation moves.

**Evidence required.** `cascadingUpdates` for the component goes to zero and `commits` drops by the same count in every pair.

---

## 8. `subscription-cleanup` — add missing listener or subscription cleanup (heap-growth)

**When.** `heap-growth` shows a constructor or closure count growing by about one per navigate-and-back cycle: an event listener, timer, animation frame, keyboard/app-state subscription or store subscription registered in an effect without a cleanup.

**How.** Return the cleanup from the effect (`remove()`, `clearInterval`, `cancelAnimationFrame`, `unsubscribe`); for class components, clear in `componentWillUnmount`. Where a listener must outlive the screen, say so and leave it.

**Risk.** Low. Cleaning up a listener another screen relies on breaks that screen; grep for the event name before removing.

**Evidence required.** `retainedObjectsPerCycle` for the constructor drops to zero across a fresh before/after snapshot pair with the same cycle count.

---

## Anything else

Not allowed. The agent reports what it would need and stops. Examples that look like performance fixes but are out of scope for Fixpoint v1: changing a query's cache policy, batching API calls, changing navigation from stack to tabs, replacing a library, reducing image sizes, editing native code.
