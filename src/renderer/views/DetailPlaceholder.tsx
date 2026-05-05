import { Button } from '../components/Button';
import { IconArrowLeft } from '../components/icons';
import styles from './DetailPlaceholder.module.css';

export interface DetailPlaceholderProps {
  onBack: () => void;
}

export function DetailPlaceholder({ onBack }: DetailPlaceholderProps): JSX.Element {
  return (
    <div className={styles.placeholder} data-testid="detail-placeholder">
      <Button
        variant="ghost"
        leadingIcon={<IconArrowLeft />}
        onClick={onBack}
        data-testid="detail-back"
      >
        Back
      </Button>
      <h2 className={styles.title}>Project detail view lands in #6</h2>
      <p className={styles.subtitle}>
        This screen will host the ticket inbox, run history, and the streaming Claude console.
      </p>
    </div>
  );
}
