#!/usr/bin/env node
import { openDb } from "./db.js";
import { loadHistoryFiles, indexEntries } from "./indexer.js";
import { ingestExtendedLog } from "./extended-log.js";

const db = openDb();
const entries = loadHistoryFiles();
const { inserted, skipped } = indexEntries(db, entries);
const ext = ingestExtendedLog(db);
console.log(
  `Parsed ${entries.length} history entries. Inserted ${inserted}, skipped ${skipped} (dupes).` +
  ` Extended-log: applied ${ext.applied}, inserted ${ext.inserted}.`
);
db.close();
