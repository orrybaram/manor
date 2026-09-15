import React, { useCallback, useRef } from "react";
import { Textarea } from "../Input/Input";
import { assignRefs, composeHandlers } from "./compose";
import { useEmojiAutocomplete } from "./useEmojiAutocomplete";

type EmojiTextareaProps = React.ComponentPropsWithoutRef<typeof Textarea>;

/**
 * `ui/Textarea` with `:shortcode` emoji autocomplete (ADR-174). Same props and
 * ref as `Textarea`; the caller's `onChange` fires for inserted emoji too.
 */
export const EmojiTextarea = React.forwardRef<
  HTMLTextAreaElement,
  EmojiTextareaProps
>((props, forwardedRef) => {
  const { onKeyDown, onInput, onSelect, onBlur, ...rest } = props;

  const innerRef = useRef<HTMLTextAreaElement>(null);
  const { handleKeyDown, fieldProps, suggestions } =
    useEmojiAutocomplete(innerRef);
  const ref = useCallback(
    (node: HTMLTextAreaElement | null) =>
      assignRefs(node, innerRef, forwardedRef),
    [forwardedRef],
  );

  return (
    <>
      <Textarea
        {...rest}
        {...fieldProps}
        ref={ref}
        onKeyDown={(e) => {
          if (handleKeyDown(e)) return;
          onKeyDown?.(e);
        }}
        onInput={composeHandlers(fieldProps.onInput, onInput)}
        onSelect={composeHandlers(fieldProps.onSelect, onSelect)}
        onBlur={composeHandlers(fieldProps.onBlur, onBlur)}
      />
      {suggestions}
    </>
  );
});

EmojiTextarea.displayName = "EmojiTextarea";
