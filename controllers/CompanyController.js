const cipzHelper = require('../helpers/cipz/cipzHelper');

exports.Check = async (req, res) => {
    const number = (req.params.number || '').trim().toUpperCase();
    if (!cipzHelper.isValidNumber(number)) {
        return res.status(400).json({error: 'invalid_registration_number'});
    }

    try {
        const result = await cipzHelper.checkCompany(number);
        if (!result.found) {
            return res.status(404).json({found: false, number, source: 'CIPZ'});
        }
        // CIPZ answered for a different number than we asked about; don't trust it.
        if (result.number.toUpperCase() !== number) {
            console.error(`CIPZ returned ${result.number} for ${number}`);
            return res.status(502).json({error: 'registry_mismatch'});
        }
        return res.json({...result, source: 'CIPZ', checked_at: new Date().toISOString()});
    } catch (err) {
        console.error('CIPZ check failed:', err.message);
        return res.status(502).json({error: 'registry_unavailable'});
    }
};
