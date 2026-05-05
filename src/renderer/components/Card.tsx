import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  elevated?: boolean;
  className?: string;
  children: ReactNode;
}

interface SlotProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  className?: string;
  children: ReactNode;
}

function CardRoot({ elevated, className, children, ...rest }: CardProps): JSX.Element {
  const classes = [styles.card];
  if (elevated) classes.push(styles.elevated);
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} {...rest}>
      {children}
    </div>
  );
}

function CardHeader({ className, children, ...rest }: SlotProps): JSX.Element {
  const classes = [styles.header];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} {...rest}>
      {children}
    </div>
  );
}

function CardBody({ className, children, ...rest }: SlotProps): JSX.Element {
  const classes = [styles.body];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} {...rest}>
      {children}
    </div>
  );
}

function CardFooter({ className, children, ...rest }: SlotProps): JSX.Element {
  const classes = [styles.footer];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} {...rest}>
      {children}
    </div>
  );
}

/**
 * Compound `<Card>` with `.Header`, `.Body`, `.Footer` slot subcomponents.
 */
export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Body: CardBody,
  Footer: CardFooter,
});
