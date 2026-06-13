const express = require("express");
const router = express.Router();
const { pool, connection, socketQueue, generateOtp, generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('@trading/shared');

router.post("/send-otp", async (req, res) => {
    const { phone, dialcode } = req.body;

    //   const otp = generateOtp();
    const otp = 123456;

    await connection.set(
        `otp:${phone}`,
        otp,
        "EX",
        300
    );

    await socketQueue.add('stock-update', { phone, dialcode, otp }, {
        removeOnComplete: true,
        removeOnFail: true
    });

    return res.json({
        success: true,
        message: "OTP sent successfully",
        data: []
    });
});

router.post("/verify-otp", async (req, res) => {
    const { phone, dialcode, otp } = req.body;
    console.log('req.headers: ', req.headers.pathname);

    const storedOtp = await connection.get(
        `otp:${phone}`
    );

    if (!storedOtp || storedOtp != otp) {
        return res.status(401).json({
            error: "Invalid OTP"
        });
    }

    // remove OTP after success
    await connection.del(`otp:${phone}`);

    const isNewUser = req.headers.pathname === '/registration';


    let result;
    if (isNewUser) {
        const username = `user${Date.now()}`

        result = await pool.query(`
            INSERT INTO users (username, phone)
            VALUES ($1, $2)
            RETURNING *;
        `, [username, phone])

    } else {
        result = await pool.query(`
            SELECT * FROM users
            WHERE phone = $1 AND 
            is_active = true AND 
            is_delete = false
        `, [phone])
    }

    const user = result.rows[0];

    if (!user) {
        throw new Error("User not found");
    }

    const accessToken =
        generateAccessToken(user);

    const refreshToken =
        generateAccessToken(user);

    // store refresh token in redis
    await connection.set(
        `refresh:${user.id}`,
        refreshToken,
        "EX",
        60 * 60 * 24 * 30
    );

    // send refresh token in cookie
    // res.cookie("refreshToken", refreshToken, {
    //     httpOnly: true,
    //     secure: true,
    //     sameSite: "none",
    //     maxAge: 30 * 24 * 60 * 60 * 1000
    // });

    return res.status(isNewUser ? 201 : 200).json({
        success: true,
        message: "Login successful",
        data: {
            accessToken,
            refreshToken,
            user
        }
    });
});


router.post("/refresh-token", async (req, res) => {
    const refreshToken =
        req.cookies?.refreshToken;

    console.log('cookies: ', req.cookie);

    if (!refreshToken) {
        return res.status(401).json({
            success: false,
            message: "Refresh token missing"
        });
    }

    // verify token
    const decoded =
        verifyRefreshToken(refreshToken);

    // compare with redis token
    const storedToken = await connection.get(
        `refresh:${decoded.userId}`
    );

    if (storedToken !== refreshToken) {
        return res.status(401).json({
            success: false,
            message: "Invalid refresh token"
        });
    }

    const result = await pool.query(`
      SELECT * FROM users
      WHERE id = $1 AND 
      is_active = true AND 
      is_delete = false
    `, [decoded.userId])

    const user = result.rows[0];

    if (!user) {
        throw new Error("User not found");
    }

    const newAccessToken =
        generateAccessToken(user);

    return res.status(200).json({
        success: true,
        message: "New access token generated",
        data: {
            accessToken: newAccessToken
        }
    });

})

router.post("/logout", async (req, res) => {

  const refreshToken =
  req.headers.refreshToken;
  console.log('refreshToken: ', refreshToken);

  if (refreshToken) {

    const decoded =
      verifyRefreshToken(refreshToken);

    await redis.del(
      `refresh:${decoded.userId}`
    );
  }

//   res.clearCookie("refreshToken");

  return res.status(200).json({
    success: true,
    message: "Logout successful",
    data: []
  });
});

module.exports = router;