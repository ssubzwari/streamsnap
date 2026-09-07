import { useEffect, useId, useState } from "react";

import { listCategories, type CategoryTree } from "@/api/downloads";

import styles from "./CategoryPicker.module.css";

export interface CategoryPickerValue {
  category: string;
  subcategory: string;
  tag: string;
}

interface Props {
  value: CategoryPickerValue;
  onChange: (next: CategoryPickerValue) => void;
  /** When true, fetch the category tree on mount. The Dashboard reuses the
   *  same picker for "download" and "subscribe", so we don't want to fetch
   *  twice — pass `tree` directly when you've already loaded it. */
  tree?: CategoryTree | null;
  /** Compact mode squeezes the inputs into less space (used in the URL row). */
  compact?: boolean;
}

/** Three free-text inputs (Category / Subcategory / Tag) backed by a
 *  <datalist> autocomplete sourced from existing downloads + a default seed
 *  list. Free text is allowed at every level — the user can type a brand-new
 *  category and it will be folder-created on the next download. */
export default function CategoryPicker({ value, onChange, tree: initialTree, compact }: Props) {
  const [tree, setTree] = useState<CategoryTree | null>(initialTree ?? null);
  const idBase = useId();

  useEffect(() => {
    if (initialTree) return;
    listCategories().then(setTree).catch(console.error);
  }, [initialTree]);

  const categories = tree ? Object.keys(tree.categories).sort() : [];
  const subcategories =
    tree && value.category && tree.categories[value.category]
      ? Object.keys(tree.categories[value.category]).sort()
      : [];
  const tags =
    tree && value.category && value.subcategory && tree.categories[value.category]?.[value.subcategory]
      ? tree.categories[value.category][value.subcategory]
      : [];

  const set = (patch: Partial<CategoryPickerValue>) =>
    onChange({ ...value, ...patch });

  return (
    <div className={`${styles.row} ${compact ? styles.compact : ""}`}>
      <label className={styles.label}>
        Category
        <input
          className={styles.input}
          list={`${idBase}-cats`}
          value={value.category}
          placeholder="None"
          onChange={(e) =>
            set({
              category: e.target.value,
              // Reset deeper levels when the parent changes.
              subcategory:
                e.target.value === value.category ? value.subcategory : "",
              tag: e.target.value === value.category ? value.tag : "",
            })
          }
        />
        <datalist id={`${idBase}-cats`}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>

      <label className={styles.label}>
        Subcategory
        <input
          className={styles.input}
          list={`${idBase}-subs`}
          value={value.subcategory}
          placeholder={value.category ? "e.g. Show / Album" : "—"}
          disabled={!value.category}
          onChange={(e) =>
            set({
              subcategory: e.target.value,
              tag: e.target.value === value.subcategory ? value.tag : "",
            })
          }
        />
        <datalist id={`${idBase}-subs`}>
          {subcategories.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>

      <label className={styles.label}>
        Tag
        <input
          className={styles.input}
          list={`${idBase}-tags`}
          value={value.tag}
          placeholder={value.subcategory ? "e.g. Season 1" : "—"}
          disabled={!value.subcategory}
          onChange={(e) => set({ tag: e.target.value })}
        />
        <datalist id={`${idBase}-tags`}>
          {tags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
    </div>
  );
}
