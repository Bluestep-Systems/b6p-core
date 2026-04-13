import type { B6PUri } from '../B6PUri';

/**
 * Interface representing an element with a file system path and URI.
 *
 * This is very specifically NOT a {@link vscode.TreeItem}, because the element it represents
 * is required to neither exist on the local filesystem, nor have an extant counterpart upstairs.
 *
 * @lastreviewed 2025-10-01
 */
export interface ScriptPathElement {

  /**
   * Gets the file system path of this element.
   * @returns The file system path as a string
   * @lastreviewed 2025-10-01
   */
  path(): string;

  /**
   * Gets the {@link B6PUri} of this element.
   * @returns The B6P URI
   * @lastreviewed 2025-10-01
   */
  uri(): B6PUri;

  /**
   * Checks if this element is equal to another element of the same type.
   * @param other The element to compare with
   * @returns True if the elements are equal, false otherwise
   * @lastreviewed 2025-10-01
   */
  equals(other: ScriptPathElement): boolean;


}

