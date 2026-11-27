# React 19 ref and context choices

Read this example only for a component API decision in React 19 or later. Inspect
the installed version and supported consumers before changing an existing API.

Function components can accept ref as a prop in React 19; forwardRef is no longer
necessary for new React-19-only components. Existing forwardRef code is not, by
itself, a correctness defect; supporting older React versions can require it.

```tsx
function ComposerInput({ ref, ...props }: Props & { ref?: React.Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} />
}
```

useContext remains supported. use() can read a context conditionally, whereas
useContext follows hook ordering rules. Choose from the actual call pattern;
do not rewrite useContext solely because a project uses React 19.

Primary contracts: [useContext](https://react.dev/reference/react/useContext),
[use](https://react.dev/reference/react/use), and
[forwardRef](https://react.dev/reference/react/forwardRef).
Adapted from Vercel agent-skills composition guidance.
