# React Composition: Worked Example

One running example (a message composer) showing the composition rules in [../SKILL.md](../SKILL.md). Adapted from Vercel's composition-patterns rules (MIT).

## 1. The problem: boolean props

```tsx
// Each flag doubles the states; the body becomes nested conditionals.
function Composer({ onSubmit, isThread, channelId, isDMThread, dmId, isEditing, isForwarding }: Props) {
  return (
    <form>
      <Header />
      <Input />
      {isDMThread ? <AlsoSendToDMField id={dmId} />
        : isThread ? <AlsoSendToChannelField id={channelId} /> : null}
      {isEditing ? <EditActions /> : isForwarding ? <ForwardActions /> : <DefaultActions />}
      <Footer onSubmit={onSubmit} />
    </form>
  )
}
```

## 2. Context interface: state, actions, meta

```tsx
interface ComposerState { input: string; attachments: Attachment[]; isSubmitting: boolean }
interface ComposerActions {
  update: (updater: (s: ComposerState) => ComposerState) => void
  submit: () => void
}
interface ComposerMeta { inputRef: React.RefObject<HTMLTextAreaElement | null> }
interface ComposerContextValue { state: ComposerState; actions: ComposerActions; meta: ComposerMeta }

const ComposerContext = createContext<ComposerContextValue | null>(null)

function useComposer(): ComposerContextValue {
  const ctx = use(ComposerContext) // useContext on React 18
  if (!ctx) throw new Error('Composer parts must be used inside a Composer provider')
  return ctx
}
```

## 3. Compound parts depend only on the interface

```tsx
function ComposerFrame({ children }: { children: React.ReactNode }) {
  return <form onSubmit={(e) => e.preventDefault()}>{children}</form>
}

function ComposerInput({ placeholder }: { placeholder?: string }) {
  const { state, actions, meta } = useComposer()
  return (
    <textarea
      ref={meta.inputRef}
      aria-label="Message"
      placeholder={placeholder}
      value={state.input}
      onChange={(e) => actions.update((s) => ({ ...s, input: e.target.value }))}
    />
  )
}

function ComposerSubmit() {
  const { state, actions } = useComposer()
  return <button type="button" disabled={state.isSubmitting} onClick={actions.submit}>Send</button>
}

function ComposerFooter({ children }: { children: React.ReactNode }) {
  return <footer className="composer-footer">{children}</footer>
}

export const Composer = {
  Frame: ComposerFrame,
  Input: ComposerInput,
  Footer: ComposerFooter,
  Submit: ComposerSubmit,
  // Header, Attachments, Formatting, Emojis, CancelEdit, SaveEdit ...
}
```

## 4. Providers own the state implementation

```tsx
// Local, ephemeral state
function ForwardMessageProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(initialState)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const forward = useForwardMessage()
  return (
    <ComposerContext value={{ state, actions: { update: setState, submit: () => forward(state) }, meta: { inputRef } }}>
      {children}
    </ComposerContext>
  )
}

// Globally synced state: same interface, different source
function ChannelProvider({ channelId, children }: { channelId: string; children: React.ReactNode }) {
  const { state, update, submit } = useGlobalChannel(channelId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  return (
    <ComposerContext value={{ state, actions: { update, submit }, meta: { inputRef } }}>
      {children}
    </ComposerContext>
  )
}
```

## 5. Explicit variants instead of modes

```tsx
function ThreadComposer({ channelId }: { channelId: string }) {
  return (
    <ThreadProvider channelId={channelId}>
      <Composer.Frame>
        <Composer.Input />
        <AlsoSendToChannelField channelId={channelId} />
        <Composer.Footer>
          <Composer.Formatting />
          <Composer.Submit />
        </Composer.Footer>
      </Composer.Frame>
    </ThreadProvider>
  )
}

function EditMessageComposer({ messageId }: { messageId: string }) {
  return (
    <EditMessageProvider messageId={messageId}>
      <Composer.Frame>
        <Composer.Input />
        <Composer.Footer>
          <Composer.CancelEdit />
          <Composer.SaveEdit />
        </Composer.Footer>
      </Composer.Frame>
    </EditMessageProvider>
  )
}
```

Call sites read clearly: `<ThreadComposer channelId="abc" />` instead of `<Composer isThread isEditing={false} channelId="abc" />`.

## 6. Lifted state reaches outside the frame

```tsx
function ForwardMessageDialog() {
  return (
    <ForwardMessageProvider>
      <Dialog>
        <Composer.Frame>
          <Composer.Input placeholder="Add a message, if you'd like." />
        </Composer.Frame>
        <MessagePreview />   {/* reads state, outside the frame */}
        <DialogActions>
          <CancelButton />
          <ForwardButton />  {/* calls submit, outside the frame */}
        </DialogActions>
      </Dialog>
    </ForwardMessageProvider>
  )
}

function ForwardButton() {
  const { actions } = useComposer()
  return <button onClick={actions.submit}>Forward</button>
}
```

Wrong alternatives this replaces: a `useEffect` in the child calling `onInputChange(state.input)` on every change, or a `stateRef` the parent reads on submit.

## 7. children vs render props

```tsx
// Static structure: children
<Composer.Footer>
  <Composer.Formatting />
  <SubmitButton />
</Composer.Footer>

// Parent passes data back: render prop is right
<List data={items} renderItem={({ item, index }) => <Row item={item} index={index} />} />
```

## 8. React 19 ref as a prop

```tsx
// React 19: no forwardRef
function TextField({ ref, ...props }: React.ComponentProps<'input'>) {
  return <input ref={ref} {...props} />
}
```
