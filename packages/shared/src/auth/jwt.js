const jwt = require("jsonwebtoken");

function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      type: "access"
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "1h"
    }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      type: "refresh"
    },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: "30d"
    }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(
    token,
    process.env.JWT_SECRET
  );
}

function verifyRefreshToken(token) {
  return jwt.verify(
    token,
    process.env.JWT_REFRESH_SECRET
  );
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
};