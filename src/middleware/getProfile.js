const getProfile = async (req, res, next) => {
    const { Profile } = req.app.get('models');
    const profileId = req.get('profile_id');

    if (!profileId) {
        return res.status(400).json({ error: 'Profile ID is missing in the request header' });
    }

    try {
        const profile = await Profile.findOne({ where: { id: profileId } });

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        req.profile = profile;
        next();
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = { getProfile };
