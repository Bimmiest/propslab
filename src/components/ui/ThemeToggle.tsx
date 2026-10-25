import { useTheme } from '../../hooks/useTheme';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <Tooltip content={label} side="bottom">
      <button
        onClick={toggleTheme}
        className="flex items-center justify-center w-8 h-8 rounded-md cursor-pointer border-none outline-none focus-visible:ring-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] press"
        aria-label={label}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="w-[18px] h-[18px]" />
      </button>
    </Tooltip>
  );
}
