import express from "express";
import "./config/db";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend Running");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});