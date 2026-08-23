type Props = {
  name: string
  files: string[]
  activeIndex: number
  onSelect: (index: number) => void
}

/** The leading panel listing the JSON files of the opened folder. */
export default function FilePanel({ name, files, activeIndex, onSelect }: Props): React.ReactElement {
  return (
    <aside className="file-panel" aria-label="Files in the opened folder">
      <div className="file-panel-title" title={name}>
        {name}
      </div>
      <ul className="file-list">
        {files.map((file, i) => (
          <li key={file}>
            <button
              type="button"
              className={`file-item${i === activeIndex ? ' active' : ''}`}
              title={file}
              aria-current={i === activeIndex}
              onClick={() => onSelect(i)}
            >
              {file}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
