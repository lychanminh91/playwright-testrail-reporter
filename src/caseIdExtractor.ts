// caseIdExtractor.ts
import fs from 'fs';
import path from 'path';

/**
 * Regex pattern to match test case IDs like "C123:" or "C123 "
 */
const pattern = /C(\d+)(:|\s)/g;

/**
 * Extract TestRail Case IDs from all files in a directory
 * @param directoryPath - Path to directory containing test files
 * @returns Promise resolving to a sorted array of unique case IDs
 */
export async function extractCaseIds(directoryPath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let testCaseIds: number[] = [];

    fs.readdir(directoryPath, (err, files) => {
      if (err) {
        return reject(`Error reading the directory: ${err}`);
      }

      try {
        files.forEach((file) => {
          const filePath = path.join(directoryPath, file);

          // Only process files (skip subdirectories)
          if (!fs.statSync(filePath).isFile()) return;

          const content = fs.readFileSync(filePath, 'utf8');

          let matches: RegExpExecArray | null;
          while ((matches = pattern.exec(content)) !== null) {
            testCaseIds.push(parseInt(matches[1], 10));
          }
        });

        // Remove duplicates and sort ascending
        testCaseIds = [...new Set(testCaseIds)].sort((a, b) => a - b);

        resolve(testCaseIds);
      } catch (error) {
        reject(`Error processing files: ${error}`);
      }
    });
  });
}

export default extractCaseIds;