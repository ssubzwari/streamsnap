import styles from "./Footer.module.css";

const REPO_URL = "https://github.com/ssubzwari/streamsnap";
const YEAR = new Date().getFullYear();

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <span className={styles.brand}>
        Stream<span className={styles.brandAccent}>Snap</span>
      </span>

      <nav className={styles.links} aria-label="Footer">
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
          GitHub
        </a>
        <span className={styles.sep}>·</span>
        <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer noopener">
          Report an issue
        </a>
        <span className={styles.sep}>·</span>
        <a
          href={`${REPO_URL}/blob/main/LICENSE`}
          target="_blank"
          rel="noreferrer noopener"
        >
          AGPL-3.0
        </a>
        <span className={styles.sep}>·</span>
        <span>&copy; {YEAR}</span>
      </nav>
    </footer>
  );
}
