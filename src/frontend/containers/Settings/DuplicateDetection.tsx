import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, IconSet } from 'widgets';
import { Callout } from 'widgets/notifications';
import { useStore } from '../../contexts/StoreContext';
import { RendererMessenger } from 'src/ipc/renderer';
import type { DedupProgress, DuplicateGroup } from 'src/backend/DuplicateDetector';

export const DuplicateDetection = observer(() => {
  const { fileStore } = useStore();

  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<DedupProgress | null>(null);
  const [results, setResults] = useState<DuplicateGroup[] | null>(null);
  const [removedGroups, setRemovedGroups] = useState<Set<string>>(new Set());
  const listenersAttached = useRef(false);

  // Set up IPC listeners on mount, clean up on unmount
  useEffect(() => {
    if (listenersAttached.current) return;
    listenersAttached.current = true;

    RendererMessenger.onDedupProgress((p) => {
      setProgress(p);
    });

    RendererMessenger.onDedupResult((result) => {
      setResults(result);
      setIsScanning(false);
    });

    return () => {
      RendererMessenger.removeDedupListeners();
      listenersAttached.current = false;
    };
  }, []);

  const handleStart = useCallback(async () => {
    const filePaths = fileStore.fileList.map((f) => f.absolutePath);
    if (filePaths.length === 0) {
      alert('No images in your library to scan for duplicates.');
      return;
    }

    setIsScanning(true);
    setResults(null);
    setProgress(null);
    await RendererMessenger.dedupStart(filePaths);
  }, [fileStore]);

  const handleStop = useCallback(async () => {
    await RendererMessenger.dedupStop();
    setIsScanning(false);
  }, []);

  /** Remove duplicates from a single group (keeps the first file, trashes the rest) */
  const handleRemoveGroup = useCallback(async (group: DuplicateGroup) => {
    const filesToRemove = group.files.slice(1); // keep first, remove rest
    const confirmed = window.confirm(
      `This will move ${filesToRemove.length} duplicate file(s) to trash, keeping:\n\n` +
      `${group.files[0]}\n\nContinue?`
    );
    if (!confirmed) return;

    for (const filePath of filesToRemove) {
      try {
        await RendererMessenger.trashFile(filePath);
      } catch (err) {
        console.error(`Failed to trash ${filePath}:`, err);
      }
    }

    // Remove trashed files from the file store
    const clientFiles = filesToRemove
      .map((p) => fileStore.fileList.find((f) => f.absolutePath === p))
      .filter(Boolean) as any[];
    if (clientFiles.length > 0) {
      await fileStore.deleteFiles(clientFiles);
    }

    setRemovedGroups((prev) => new Set([...prev, group.hash]));
  }, [fileStore]);

  /** Remove duplicates from ALL groups */
  const handleRemoveAll = useCallback(async () => {
    if (!results) return;
    const remainingGroups = results.filter((g) => !removedGroups.has(g.hash));
    const totalToRemove = remainingGroups.reduce((sum, g) => sum + g.files.length - 1, 0);

    const confirmed = window.confirm(
      `This will move ${totalToRemove} duplicate file(s) to trash across ${remainingGroups.length} groups.\n\n` +
      `The first file in each group will be kept.\n\nContinue?`
    );
    if (!confirmed) return;

    for (const group of remainingGroups) {
      const filesToRemove = group.files.slice(1);
      for (const filePath of filesToRemove) {
        try {
          await RendererMessenger.trashFile(filePath);
        } catch (err) {
          console.error(`Failed to trash ${filePath}:`, err);
        }
      }

      const clientFiles = filesToRemove
        .map((p) => fileStore.fileList.find((f) => f.absolutePath === p))
        .filter(Boolean) as any[];
      if (clientFiles.length > 0) {
        await fileStore.deleteFiles(clientFiles);
      }

      setRemovedGroups((prev) => new Set([...prev, group.hash]));
    }
  }, [results, removedGroups, fileStore]);

  const phaseLabel = (phase: DedupProgress['phase']) => {
    switch (phase) {
      case 'sizing':
        return 'Grouping by file size';
      case 'hashing':
        return 'Computing file hashes';
      case 'done':
        return 'Complete';
    }
  };

  const totalDuplicateFiles = results
    ? results.reduce((sum, group) => sum + group.files.length, 0)
    : 0;

  return (
    <>
      <h3>Duplicate Detection</h3>
      <Callout icon={IconSet.INFO}>
        Scans your library for exact duplicate images by comparing file sizes and MD5 hashes. This
        runs as a background process and will not block the UI.
      </Callout>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}
      >
        {!isScanning ? (
          <Button
            text={`Scan ${fileStore.numTotalFiles} Images`}
            onClick={handleStart}
            styling="filled"
            icon={IconSet.SEARCH}
          />
        ) : (
          <Button text="Stop Scan" onClick={handleStop} styling="outlined" icon={IconSet.CLOSE} />
        )}
      </div>

      {isScanning && progress && (
        <div style={{ marginTop: '8px' }}>
          <p>
            {phaseLabel(progress.phase)}: {progress.processed} / {progress.total}
            {progress.duplicatesFound > 0 &&
              ` — ${progress.duplicatesFound} duplicate group(s) found`}
          </p>
          <progress
            value={progress.processed}
            max={progress.total}
            style={{ width: '100%' }}
          />
        </div>
      )}

      {!isScanning && results !== null && (
        <div style={{ marginTop: '12px' }}>
          {results.length === 0 ? (
            <p>No duplicates found.</p>
          ) : (
            <>
              <p>
                Found <strong>{results.length}</strong> duplicate group(s) containing{' '}
                <strong>{totalDuplicateFiles}</strong> files total.
              </p>
              {results.some((g) => !removedGroups.has(g.hash)) && (
                <Button
                  text="Remove All Duplicates"
                  onClick={handleRemoveAll}
                  styling="filled"
                  icon={IconSet.DELETE}
                />
              )}
              <div
                style={{
                  maxHeight: '400px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-color, #444)',
                  borderRadius: '4px',
                  padding: '8px',
                  marginTop: '8px',
                }}
              >
                {results.map((group, idx) => {
                  const isRemoved = removedGroups.has(group.hash);
                  return (
                    <details key={group.hash} style={{ marginBottom: '8px', opacity: isRemoved ? 0.5 : 1 }}>
                      <summary style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>
                          Group {idx + 1} — {group.files.length} files (hash: {group.hash.slice(0, 8)}…)
                        </span>
                        {isRemoved && <span style={{ color: 'green', fontSize: '0.85em' }}>✓ Removed</span>}
                      </summary>
                      <ul style={{ margin: '4px 0', paddingLeft: '20px' }}>
                        {group.files.map((filePath, fileIdx) => (
                          <li
                            key={filePath}
                            style={{
                              fontSize: '0.85em',
                              wordBreak: 'break-all',
                              marginBottom: '2px',
                              fontWeight: fileIdx === 0 ? 'bold' : 'normal',
                            }}
                          >
                            {fileIdx === 0 ? '✓ Keep: ' : '✗ Remove: '}
                            {filePath}
                          </li>
                        ))}
                      </ul>
                      {!isRemoved && (
                        <Button
                          text="Remove Duplicates in This Group"
                          onClick={() => handleRemoveGroup(group)}
                          styling="outlined"
                          icon={IconSet.DELETE}
                        />
                      )}
                    </details>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
});
