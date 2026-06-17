const express = require("express");
const router = express.Router();
const { pool, socketQueue } = require('@trading/shared');

// add stock
router.post("/add-stock", async (req, res) => {
  const client = await pool.connect();

  try {
    const { userId = 1, symbol, shares } = req.body;

    // Validation
    if (!userId || !symbol) {
      return res.status(400).json({
        success: false,
        message: "userId and symbol are required"
      });
    }

    // Check duplicate watchlist entry
    const existing = await client.query(
    `SELECT id
      FROM watchlists
      WHERE user_id = $1
        AND symbol = $2
        AND is_active = true
        AND is_deleted = false
    `, [userId, symbol]);

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Stock already exists in watchlist"
      });
    }

    const stockResult = await client.query(`
      SELECT * FROM public.market_stock_snapshots
      WHERE symbol = $1 AND created_at = (
        SELECT MAX(created_at)
        FROM public.market_stock_snapshots
      )
    `, [symbol])

    if (stockResult.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Stock does not exist"
      });
    }

    const price = stockResult.rows[0].last_price;
    const volume = stockResult.rows[0].volume;

    // Insert into watchlist
    const watchResult = await client.query(
    `INSERT INTO watchlists
      (user_id, symbol, buy_price, buy_volume, quantity)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [userId, symbol, price, volume, shares]);

    const watchListId = watchResult.rows[0].id;

    const targetResult = await client.query(
    `INSERT INTO watchlist_targets
      (watchlist_id, target_percent, is_sell)
      VALUES ($1, $2, true), ($1, $3, true), ($1, $4, true),  ($1, $3, false)
      RETURNING *
    `, [watchListId, 3, 5, 10])

    await client.query("COMMIT");
    await socketQueue.add('watchlist', {}, {
      removeOnComplete: true,
      removeOnFail: true
    });

    return res.status(201).json({
      success: true,
      message: "Added to watchlist successfully",
      data: watchResult.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Add Watchlist Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  } finally {
    client.release();
  }
});

// sell stock
router.post("/sell-stock", async (req, res) => {
  const client = await pool.connect();

  try {
    const { userId = 1, symbol } = req.body;

    // Validation
    if (!userId || !symbol) {
      return res.status(400).json({
        success: false,
        message: "userId and symbol are required"
      });
    }

    // Check duplicate watchlist entry
    const existing = await client.query(
    `SELECT id
      FROM watchlists
      WHERE user_id = $1
        AND symbol = $2
        AND is_active = true
        AND is_deleted = false
    `, [userId, symbol]);

    if (existing.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Stock does not exist in watchlist"
      });
    }

    const stockResult = await client.query(`
      SELECT *
        FROM public.market_stock_snapshots
        WHERE symbol = $1 AND created_at = (
          SELECT MAX(created_at)
          FROM public.market_stock_snapshots
        )
    `, [symbol])

    if (stockResult.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Stock does not exist"
      });
    }

    const price = stockResult.rows[0].last_price;
    const volume = stockResult.rows[0].volume;

    // Insert into watchlist
    const watchResult = await client.query(
    `UPDATE watchlists
      SET sell_price = $3,
      sell_volume = $4,
      status = $5,
      updated_at = NOW()
      WHERE user_id = $1
        AND symbol = $2
        AND is_active = true
        AND is_deleted = false
      RETURNING *
    `, [userId, symbol, price, volume, 'SOLD']);

    if (watchResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Active watchlist entry not found"
      });
    }

    const watchListId = watchResult.rows[0].id;

    const targetResult = await client.query(
    `UPDATE watchlist_targets
      SET is_active = false,
      updated_at = NOW()
      WHERE watchlist_id = $1
      RETURNING *
    `, [watchListId]);

    await client.query("COMMIT");
    await socketQueue.add('watchlist', {}, {
      removeOnComplete: true,
      removeOnFail: true
    });

    return res.status(200).json({
      success: true,
      message: "Sold stock successfully",
      data: watchResult.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Sell Watchlist Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  } finally {
    client.release();
  }
});

// update stock target percent
router.post("/update-stock-target", async (req, res) => {
  try {
    const { targets } = req.body;

    if (!Array.isArray(targets)) {
      return res.status(400).json({
        success: false,
        message: "targets must be an array"
      });
    }

    const finalResult = [];
    for (const target of targets) {
      if (!target.id || !target.targetPercent ) {
        continue;
      }

      const result = await pool.query(`
        UPDATE watchlist_targets
        SET target_percent = $2,
        updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [target.id, target.targetPercent])
        
      finalResult.push(result.rows[0]);
    }

    await socketQueue.add('watchlist', {}, {
      removeOnComplete: true,
      removeOnFail: true
    });

    return res.status(201).json({
      success: true,
      message: "Updated watch target successfully",
      data: finalResult
    });

  } catch (error) {
    console.error("Update Stock Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
});

// active deactive stock target by targetId
router.post("/update-stock-target-status", async (req, res) => {
  try {
    const { targetId } = req.body;

    if (!targetId) {
      return res.status(400).json({
        success: false,
        message: "targetId is required"
      });
    }

    const result = await pool.query(
    `UPDATE watchlist_targets
      SET is_active = NOT is_active,
      updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [targetId])

    await socketQueue.add('watchlist', {}, {
      removeOnComplete: true,
      removeOnFail: true
    });

    return res.status(201).json({
      success: true,
      message: "Updated watch target successfully",
      data: result.rows[0]
    });

  } catch (error) {
    console.error("Update Stock Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
});

// active all stocks target by watchListId
router.post("/update-stock-targets-status", async (req, res) => {
  try {
    const { watchListId } = req.body;

    if (!watchListId) {
      return res.status(400).json({
        success: false,
        message: "watchListId is required"
      });
    }

    const result = await pool.query(
    `UPDATE watchlist_targets
      SET is_active = true,
      updated_at = NOW()
      WHERE watchlist_id = $1
      AND is_sell = true
      RETURNING *
    `, [watchListId])

    await socketQueue.add('watchlist', {}, {
      removeOnComplete: true,
      removeOnFail: true
    });

    return res.status(201).json({
      success: true,
      message: "Updated watch target successfully",
      data: result.rows
    });

  } catch (error) {
    console.error("Update Stock Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
});

// delete stock
router.post("/delete-stock", async (req, res) => {
  const client = await pool.connect();

  try {
    const { userId = 1, symbol } = req.body;

    // Validation
    if (!userId || !symbol) {
      return res.status(400).json({
        success: false,
        message: "userId and symbol are required"
      });
    }

    // Check duplicate watchlist entry
    const existing = await client.query(
    `SELECT id
      FROM watchlists
      WHERE user_id = $1
        AND symbol = $2
        AND is_active = true
        AND is_deleted = false
    `, [userId, symbol]);

    if (existing.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Stock does not exist in watchlist"
      });
    }

    // Insert into watchlist
    const watchResult = await client.query(
    `UPDATE watchlists
      SET is_deleted = true,
      updated_at = NOW()
      WHERE user_id = $1
        AND symbol = $2
        AND is_active = true
        AND is_deleted = false
      RETURNING *
    `, [userId, symbol]);

    if (watchResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Active watchlist entry not found"
      });
    }

    const watchListId = watchResult.rows[0].id;

    const targetResult = await client.query(
    `UPDATE watchlist_targets
      SET is_deleted = true,
      updated_at = NOW()
      WHERE watchlist_id = $1
      RETURNING *
    `, [watchListId]);

    await client.query("COMMIT");
    await socketQueue.add('watchlist', {}, {
      removeOnComplete: true,
      removeOnFail: true
    });

    return res.status(200).json({
      success: true,
      message: "Sold stock successfully",
      data: watchResult.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete Watchlist Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  } finally {
    client.release();
  }
});

module.exports = router;