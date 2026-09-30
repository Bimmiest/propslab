// @vitest-environment jsdom
// WCAG 1.4.13: content that appears on hover or focus must be hoverable, so a
// pointer moving onto it does not dismiss it. A `pointer-events-none` content
// element cannot be hovered (#495).
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { Tooltip } from '../Tooltip';

describe('Tooltip', () => {
  it('leaves its content able to receive the pointer', () => {
    render(
      <RadixTooltip.Provider>
        <Tooltip content="A long explanation worth reading">
          <button type="button">Trigger</button>
        </Tooltip>
      </RadixTooltip.Provider>,
    );
    act(() => screen.getByRole('button', { name: 'Trigger' }).focus());
    const content = screen.getAllByText('A long explanation worth reading')[0]!.closest('[data-radix-popper-content-wrapper] > *');
    expect(content).not.toBeNull();
    expect(content).not.toHaveClass('pointer-events-none');
  });
});
