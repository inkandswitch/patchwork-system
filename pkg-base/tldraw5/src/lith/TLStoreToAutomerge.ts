import type { RecordsDiff, TLRecord } from "@tldraw/tldraw";
import type { TLDrawDoc } from "../datatype.ts";
import { isObject, forIn, isArray, mapValues } from "lodash";

/** Prepares a value for storing in Automerge (deep recursively)
 *  For now, all it does is convert strings to RawStrings.
 *  This is critical for performance because TLDraw can generate large
 *  strings for inline assets, which create huge documents.
 *  There's also no support for string merging anyway in TLDraw,
 *  so raw strings work fine.
 */
export function tldrawValueToAutomergeValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map(tldrawValueToAutomergeValue);
  }
  if (isObject(value)) {
    return mapValues(value, tldrawValueToAutomergeValue);
  }
  return value;
}

export function applyTLStoreChangesToAutomerge(
  doc: TLDrawDoc,
  changes: RecordsDiff<TLRecord>
) {
  Object.values(changes.added).forEach((record) => {
    doc.store[record.id] = tldrawValueToAutomergeValue(record);
  });

  Object.values(changes.updated).forEach(([_, record]) => {
    deepCompareAndUpdate(doc.store[record.id], record);
  });

  Object.values(changes.removed).forEach((record) => {
    delete doc.store[record.id];
  });
}

function deepCompareAndUpdate(objectA: any, objectB: any) {
  if (isArray(objectB)) {
    if (!isArray(objectA)) {
      // if objectA is not an array, replace it with objectB
      objectA = objectB.map(tldrawValueToAutomergeValue);
    } else {
      // compare and update array elements
      for (let i = 0; i < objectB.length; i++) {
        if (i >= objectA.length) {
          objectA.push(tldrawValueToAutomergeValue(objectB[i]));
        } else {
          if (isObject(objectB[i]) || isArray(objectB[i])) {
            // if element is an object or array, recursively compare and update
            deepCompareAndUpdate(objectA[i], objectB[i]);
          } else if (objectA[i] !== objectB[i]) {
            // update the element
            objectA[i] = tldrawValueToAutomergeValue(objectB[i]);
          }
        }
      }
      // remove extra elements
      if (objectA.length > objectB.length) {
        objectA.splice(objectB.length);
      }
    }
  } else if (isObject(objectB)) {
    forIn(objectB, (value: any, key: any) => {
      if (objectA[key] === undefined) {
        // if key is not in objectA, add it
        objectA[key] = tldrawValueToAutomergeValue(value);
      } else {
        if (isObject(value) || isArray(value)) {
          // if value is an object or array, recursively compare and update
          deepCompareAndUpdate(objectA[key], value);
        } else if (objectA[key] !== value) {
          // update the value
          objectA[key] = tldrawValueToAutomergeValue(value);
        }
      }
    });
    forIn(objectA, (_: any, key: string) => {
      if ((objectB as any)[key] === undefined) {
        // if key is not in objectB, remove it
        delete objectA[key];
      }
    });
  }
}
