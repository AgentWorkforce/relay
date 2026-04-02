'use client';

import React, { Fragment } from 'react';

import {
  getSpawnOptionName,
  getSpawnOptionRows,
  type SpawnOptionsTableVariant,
} from '../../lib/spawn-options-table';
import { useDocsLanguage } from './DocsLanguageContext';

type SpawnOptionsTableProps = {
  variant: SpawnOptionsTableVariant;
};

export function SpawnOptionsTable({ variant }: SpawnOptionsTableProps) {
  const { language } = useDocsLanguage();
  const rows = getSpawnOptionRows(variant).filter((row) => getSpawnOptionName(row, language).length > 0);

  return (
    <table>
      <thead>
        <tr>
          <th>Option</th>
          <th>What it does</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const optionNames = getSpawnOptionName(row, language);
          return (
            <tr key={`${variant}:${optionNames.join(',')}`}>
              <td>
                {optionNames.map((name, index) => (
                  <Fragment key={name}>
                    {index > 0 ? ', ' : null}
                    <code>{name}</code>
                  </Fragment>
                ))}
              </td>
              <td>{row.description}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
