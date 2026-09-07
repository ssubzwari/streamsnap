import styles from "./Skeleton.module.css";

interface SkeletonProps {
  width?: string;
  height?: string;
  className?: string;
}

export function Skeleton({ width = "100%", height = "16px", className }: SkeletonProps) {
  return (
    <span
      className={`${styles.skeleton} ${className ?? ""}`}
      style={{ width, height, display: "inline-block" }}
      aria-hidden="true"
    />
  );
}

export function SkeletonRow() {
  return (
    <tr className={styles.skeletonRow}>
      <td><Skeleton width="16px" height="16px" /></td>
      <td><Skeleton width="60%" height="14px" /></td>
      <td><Skeleton width="40px" height="14px" /></td>
      <td><Skeleton width="40px" height="14px" /></td>
      <td><Skeleton width="60px" height="14px" /></td>
      <td><Skeleton width="50px" height="14px" /></td>
      <td><Skeleton width="80px" height="14px" /></td>
    </tr>
  );
}
