const express = require("express");
const router = express.Router();
const { pool } = require('@trading/shared');

router.get("/signal-types", async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM public.fibonacci_signal_types
    WHERE is_deleted = false
    ORDER BY id ASC 
  `);

  res.status(201).json({
    success: true,
    message: "Fetched successfully",
    data: result.rows
  })
});

router.delete("/signal-level/:signalId", async (req, res) => {
  const { signalId } = req.params;
  const result = await pool.query(`
    UPDATE fibonacci_levels
    SET is_deleted = true
    WHERE id = $1
    RETURNING *
  `, [signalId]
  );

  res.status(201).json({
    success: true,
    message: "Deleted successfully",
    data: result.rows
  })
});

router.post("/signal-level", async (req, res) => {

  const { symbol, levels = [] } = req.body;

  const finalResult = [];

  for (const level of levels) {
    let result;
    if (level.id) {
      result = await pool.query(`
        UPDATE fibonacci_levels
        SET symbol = $1, 
        level_percent = $2, 
        color = $3, 
        signal_id = $4
        WHERE id = $5
        RETURNING id, level_percent, level_price, trend_direction, signal_id, color, is_active;
      `, [symbol, level.level_percent, level.color, level.signal_id, level.id]);

    } else {
      result = await pool.query(`
        INSERT INTO fibonacci_levels
        (symbol, level_percent, color, signal_id)
        VALUES ($1,$2,$3,$4)
        RETURNING id, level_percent, level_price, trend_direction, signal_id, color, is_active;
      `, [symbol, level.level_percent, level.color, level.signal_id]);

    }

    finalResult.push(result.rows[0]);
  }


  res.status(201).json({
    success: true,
    message: "Added successfully",
    data: finalResult
  })
});

module.exports = router;