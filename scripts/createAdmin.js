// Creates an admin for the /admin site, or sets a new password for one that exists.
//   npm run admin:create -- --email you@smatid.com --name "Your Name"
// The password is asked for and not echoed.
require('dotenv').config({quiet: true});
const readline = require('readline');
const db = require('../models');
const passwordHelper = require('../helpers/passwordHelper');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
}

function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
        rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '');
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

(async () => {
    const email = String(arg('email') || '').trim().toLowerCase();
    const name = String(arg('name') || '').trim();
    if (!email || !email.includes('@')) throw new Error('Give --email');

    const password = await askHidden('Password: ');
    if (password.length < passwordHelper.MIN_LENGTH) throw new Error(`Use at least ${passwordHelper.MIN_LENGTH} characters`);
    if ((await askHidden('Again: ')) !== password) throw new Error('The passwords do not match');

    const password_hash = await passwordHelper.hash(password);
    const existing = await db.admin.findOne({where: {email}});
    if (existing) {
        await existing.update({password_hash, ...(name && {name})});
        // A new password signs out everywhere.
        await db.admin_session.destroy({where: {admin_id: existing.id}});
        console.log(`Password changed for ${email}`);
    } else {
        if (!name) throw new Error('Give --name for a new admin');
        await db.admin.create({email, name, password_hash});
        console.log(`Admin ${email} created`);
    }
})()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(() => db.sequelize.close());
