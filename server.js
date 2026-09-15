const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve files from the public folder
app.use(express.static("public"));

// Basic test route
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    app: "TastTestEarn",
    message: "TastTestEarn server is running!"
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`TastTestEarn running on port ${PORT}`);
});
