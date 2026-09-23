import type React from 'react';

/**
 * Props that make a non-button element operable from the keyboard the way a
 * `<button>` is: focusable, announced as a button, and activated by Enter or
 * Space. For the places where the element has to stay a span or div — inline
 * in wrapped text, or a flex row a real button would restyle — rather than a
 * substitute for using `<button>` where one fits.
 *
 * Hover-driven highlighting should also listen to focus, or a keyboard user
 * gets the action without the feedback; `onFocusChange` covers that.
 */
export function pressable(
  onPress: () => void,
  onFocusChange?: (focused: boolean) => void,
): Pick<React.HTMLAttributes<HTMLElement>, 'role' | 'tabIndex' | 'onClick' | 'onKeyDown' | 'onFocus' | 'onBlur'> {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e) => {
      // Only when the element itself has focus: a key pressed inside a nested
      // control belongs to that control.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      }
    },
    ...(onFocusChange && {
      onFocus: () => onFocusChange(true),
      onBlur: () => onFocusChange(false),
    }),
  };
}
