import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'ghost' | 'destructive' | 'icon';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

/**
 * Primary action button. Variants:
 *  - `primary`: solid accent — only one per surface, ideally
 *  - `ghost`: transparent until hovered; default for secondary actions
 *  - `destructive`: tinted red — irreversible actions
 *  - `icon`: square, no label, used with `leadingIcon`
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  const classes = [styles.button, styles[variant], styles[size]];
  if (fullWidth) classes.push(styles.fullWidth);

  return (
    <button ref={ref} type={type} className={classes.join(' ')} {...rest}>
      {leadingIcon && <span className={styles.leadingIcon}>{leadingIcon}</span>}
      {children}
      {trailingIcon && <span className={styles.trailingIcon}>{trailingIcon}</span>}
    </button>
  );
});
