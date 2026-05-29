export const prerender = false;

import fs from "fs";
import path from "path";

export async function GET({ params }) {

  const fileName = params?.file || "The-Funk-Strut.zip";

  const filePath = path.join(
    process.cwd(),
    "public",
    "downloads",
    fileName
  );

  if (!fs.existsSync(filePath)) {

    return new Response("File not found", {
      status: 404
    });

  }

  const fileBuffer = fs.readFileSync(filePath);

  return new Response(fileBuffer, {

    headers: {

      "Content-Type": "application/zip",

      "Content-Disposition":
        `attachment; filename="${fileName}"`

    }

  });

}