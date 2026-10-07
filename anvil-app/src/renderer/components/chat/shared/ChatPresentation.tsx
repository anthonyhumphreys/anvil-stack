import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from 'react';

export interface ChatComposerFrameProps {
  children: ReactNode;
  frameRef?: Ref<HTMLDivElement>;
  className?: string;
}

/** The shared width and padding around desktop and browser composers. */
export function ChatComposerFrame({ children, frameRef, className = '' }: ChatComposerFrameProps) {
  return (
    <div className={`bg-transparent px-3 pb-3 pt-2 xl:px-5 xl:pb-4 xl:pt-3 ${className}`}>
      <div ref={frameRef} className="mx-auto w-full max-w-[1040px]">
        {children}
      </div>
    </div>
  );
}

export interface ChatComposerSurfaceProps {
  children: ReactNode;
  hasContent?: boolean;
  disabled?: boolean;
  draggingFiles?: boolean;
  draggingIcon?: ReactNode;
  onDragEnter?: HTMLAttributes<HTMLDivElement>['onDragEnter'];
  onDragOver?: HTMLAttributes<HTMLDivElement>['onDragOver'];
  onDragLeave?: HTMLAttributes<HTMLDivElement>['onDragLeave'];
  onDrop?: HTMLAttributes<HTMLDivElement>['onDrop'];
  className?: string;
}

/** The shared border, focus, and file-drop treatment around chat input. */
export function ChatComposerSurface({
  children,
  hasContent = false,
  disabled = false,
  draggingFiles = false,
  draggingIcon,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  className = '',
}: ChatComposerSurfaceProps) {
  return (
    <div
      className={`relative rounded-xl border bg-bg-secondary transition-[border-color,background-color] duration-200 focus-within:border-accent/70 focus-within:ring-1 focus-within:ring-accent/25 ${
        disabled ? 'opacity-60' : ''
      } ${
        draggingFiles
          ? 'border-accent bg-accent/5'
          : hasContent
            ? 'border-border bg-bg-secondary'
            : 'border-border-subtle'
      } ${className}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {draggingFiles && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border border-dashed border-accent bg-bg-primary/80 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-medium text-text-primary">
            {draggingIcon}
            Drop files to attach
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

export interface ChatComposerEditorProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className' | 'style' | 'ref'
> {
  inputRef?: Ref<HTMLTextAreaElement>;
  className?: string;
  style?: TextareaHTMLAttributes<HTMLTextAreaElement>['style'];
}

/** A textarea with the spacing and typography used by the desktop chat composer. */
export function ChatComposerEditor({
  inputRef,
  className = '',
  style,
  ...textareaProps
}: ChatComposerEditorProps) {
  return (
    <textarea
      {...textareaProps}
      ref={inputRef}
      className={`chat-composer-textarea block w-full resize-none bg-transparent px-4 pb-3 pt-4 text-sm leading-6 text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50 ${className}`}
      style={{ maxHeight: '200px', minHeight: '72px', ...style }}
    />
  );
}

export interface ChatComposerFooterProps {
  children: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Shared footer spacing; callers provide their own controls and behavior. */
export function ChatComposerFooter({
  children,
  compact = false,
  className = '',
}: ChatComposerFooterProps) {
  return (
    <div
      className={`flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pb-2 pt-1 ${
        compact ? 'flex-col items-stretch' : 'justify-between'
      } ${className}`}
    >
      {children}
    </div>
  );
}

export interface ChatMessageRowProps extends HTMLAttributes<HTMLDivElement> {
  align: 'start' | 'end';
}

/** Shared outer framing for user, assistant, and browser chat messages. */
export function ChatMessageRow({ align, className = '', ...props }: ChatMessageRowProps) {
  return (
    <div
      {...props}
      className={`message-bubble group flex ${align === 'end' ? 'justify-end' : 'justify-start'} ${className}`.trim()}
    />
  );
}

export type ChatAssistantMessageHeaderProps = HTMLAttributes<HTMLDivElement>;

/** Header spacing and type treatment for assistant messages. */
export function ChatAssistantMessageHeader({
  className = '',
  ...props
}: ChatAssistantMessageHeaderProps) {
  return (
    <div
      {...props}
      className={`mb-1.5 flex items-center gap-2 px-1 text-xs font-medium text-text-tertiary ${className}`.trim()}
    />
  );
}

export type ChatAssistantMessageBodyProps = HTMLAttributes<HTMLDivElement>;

/** Width, wrapping, and typography for assistant response content. */
export function ChatAssistantMessageBody({
  className = '',
  ...props
}: ChatAssistantMessageBodyProps) {
  return (
    <div
      {...props}
      className={`max-w-[72ch] break-words px-1 text-sm leading-[1.7] text-text-primary/90 ${className}`.trim()}
    />
  );
}

export type ChatAssistantMessageFrameProps = HTMLAttributes<HTMLDivElement>;

/** The full-width content column inside an assistant message row. */
export function ChatAssistantMessageFrame({
  className = '',
  ...props
}: ChatAssistantMessageFrameProps) {
  return <div {...props} className={`relative w-full ${className}`.trim()} />;
}

export type ChatAssistantMessageActionsProps = HTMLAttributes<HTMLDivElement>;

/** Positions copy/branch/regenerate actions below an assistant response. */
export function ChatAssistantMessageActions({
  className = '',
  ...props
}: ChatAssistantMessageActionsProps) {
  return <div {...props} className={`message-actions left-0 mt-1 ${className}`.trim()} />;
}

export type ChatUserMessageFrameProps = HTMLAttributes<HTMLDivElement>;

/** The right-aligned width constraint inside a user message row. */
export function ChatUserMessageFrame({ className = '', ...props }: ChatUserMessageFrameProps) {
  return <div {...props} className={`relative w-fit min-w-0 max-w-[72ch] ${className}`.trim()} />;
}

export type ChatUserMessageHeaderProps = HTMLAttributes<HTMLParagraphElement>;

/** Right-aligned speaker and delivery metadata treatment for user messages. */
export function ChatUserMessageHeader({ className = '', ...props }: ChatUserMessageHeaderProps) {
  return (
    <p
      {...props}
      className={`mb-1.5 flex items-center justify-end gap-1.5 text-right text-xs font-medium text-text-tertiary ${className}`.trim()}
    />
  );
}

export interface ChatUserMessageSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  collapsible?: boolean;
}

/** Border, fill, and padding around the user’s submitted message. */
export function ChatUserMessageSurface({
  collapsible = false,
  className = '',
  ...props
}: ChatUserMessageSurfaceProps) {
  return (
    <div
      {...props}
      className={`overflow-hidden rounded-xl border px-4 py-3 text-sm text-text-primary transition-colors ${
        collapsible
          ? 'border-border-subtle bg-bg-secondary/45 hover:border-border'
          : 'border-border bg-bg-secondary/70 hover:border-accent/30'
      } ${className}`.trim()}
    />
  );
}

export type ChatUserMessageActionsProps = HTMLAttributes<HTMLDivElement>;

/** Positions copy/edit/branch actions below a user message. */
export function ChatUserMessageActions({ className = '', ...props }: ChatUserMessageActionsProps) {
  return (
    <div
      {...props}
      className={`message-actions right-0 mt-1 flex justify-end ${className}`.trim()}
    />
  );
}

export type ChatEmptyStateFrameProps = HTMLAttributes<HTMLDivElement>;

/** Centers empty conversation content using the desktop chat dimensions. */
export function ChatEmptyStateFrame({ className = '', ...props }: ChatEmptyStateFrameProps) {
  return (
    <div
      {...props}
      className={`flex h-full w-full items-center justify-center px-4 py-10 ${className}`.trim()}
    />
  );
}

export const CHAT_PROMPT_SUGGESTION_BUTTON_CLASS =
  'rounded-lg px-3 py-2 text-sm font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary focus-visible:bg-bg-tertiary focus-visible:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';

/** Desktop suggestion chip styling, with normal button props for injected actions. */
export function ChatPromptSuggestionButton({
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className={`${CHAT_PROMPT_SUGGESTION_BUTTON_CLASS} ${className}`.trim()} />
  );
}

export interface ChatThreadItemFrameProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean;
}

/** Shared selected and hover states for a chat thread in the rail. */
export function ChatThreadItemFrame({
  active = false,
  className = '',
  ...props
}: ChatThreadItemFrameProps) {
  return (
    <div
      {...props}
      className={`group flex min-w-0 rounded-lg transition-colors ${
        active ? 'bg-accent/10' : 'hover:bg-bg-tertiary/55'
      } ${className}`.trim()}
    />
  );
}

export interface ChatThreadItemButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  compact?: boolean;
}

/** Shared hit target and focus treatment for a thread row. */
export function ChatThreadItemButton({
  compact = false,
  className = '',
  ...props
}: ChatThreadItemButtonProps) {
  return (
    <button
      {...props}
      className={`flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
        compact ? 'px-2.5 py-2' : 'px-2.5 py-2.5'
      } ${className}`.trim()}
    />
  );
}

export interface ChatPromptSuggestion {
  label: string;
  prompt: string;
}
