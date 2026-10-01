import mongoose from "mongoose";
import Page from "./src/server/models/Page.js";
import { connectDb } from "./src/server/db.js";

async function test() {
  await connectDb();
  const page = await Page.findOne({ "issues.0": { $exists: true } }).sort({ createdAt: -1 });
  if (!page) {
    console.log("No page found with issues");
    process.exit(0);
  }
  const issue = page.issues[0];
  console.log("BookId:", page.bookId.toString());
  console.log("PageNumber:", page.pageNumber);
  console.log("Issue UID:", issue.uid);
  
  const res = await fetch(`http://localhost:3001/api/books/${page.bookId.toString()}/pages/${page.pageNumber}/issues/${issue.uid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "accepted" })
  });
  const data = await res.json();
  console.log("Status:", res.status, data);
  process.exit(0);
}
test().catch(console.error);
