const yenteHelper = require('../helpers/sanctions/yenteHelper');

exports.Check = async (req, res) => {
    const {query, error} = yenteHelper.buildQuery(req.body || {});
    if (error) return res.status(400).json({error});

    try {
        const result = await yenteHelper.screen(query);
        return res.json({...result, source: 'OpenSanctions', checked_at: new Date().toISOString()});
    } catch (err) {
        // yente answers 503 while it builds its first index.
        console.error('Sanctions check failed:', err.response ? `HTTP ${err.response.status}` : err.message);
        return res.status(502).json({error: 'screening_unavailable'});
    }
};
