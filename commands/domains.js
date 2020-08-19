const fs = require('fs');
const path = require('path');

const axios = require('axios');
const chalk = require('chalk');
const inquirer = require('inquirer');
const level = require('level');

// foundational HTTP setup to Cloudflare's API
axios.defaults.baseURL = 'https://api.cloudflare.com/client/v4';

// check if local redirect description exists
function findDescription(domain, dir) {
  // create file path for both available formats
  let redir_filepath_json = path.join(process.cwd(), dir, `${domain}.json`);
  let redir_filepath_yaml = path.join(process.cwd(), dir, `${domain}.yaml`);
  // check if file exists
  if (fs.existsSync(redir_filepath_json)) {
    return path.relative(process.cwd(), redir_filepath_json);
  }
  if (fs.existsSync(redir_filepath_yaml)) {
    return path.relative(process.cwd(), redir_filepath_yaml);
  }
  return false;
}

/**
 * Lists available Zones/Sites in Cloudflare
 **/
exports.command = ['domains', 'zones'];
exports.describe = 'List domains in the current Cloudflare account';
exports.builder = (yargs) => {
  yargs.option('cloudflareToken', {
    describe: `API (Bearer) token for the Cloudflare API (WR_CLOUDFLARE_TOKEN)`,
    demandOption: true,
    type: 'string'
  }).option('configDir', {
    type: 'string',
    describe: 'directory containing the redirect descriptions (WR_CONFIG_DIR)',
    default: '.',
    coerce(v) {
      return {
        name: v,
        contents: fs.readdirSync(v, 'utf8')
      };
    }
  });
};
exports.handler = (argv) => {
  axios.defaults.headers.common['Authorization'] = `Bearer ${argv.cloudflareToken}`;
  axios.get('/zones')
    .then((resp) => {
      // setup a local level store for key/values (mostly)
      const db = level(`${process.cwd()}/.cache-db`);

      console.log(`${chalk.bold(resp.data.result.length)} Zones:`);
      // loop through the returned zones and store a domain => id mapping
      let zone_names = [];
      resp.data.result.forEach((zone) => {
        zone_names.push(zone.name);
        console.log(`
  ${chalk.bold(zone.name)} - ${zone.id} in ${zone.account.name}
  ${zone.status === 'active' ? chalk.green('✓') : chalk.blue('🕓')} ${chalk.green(zone.plan.name)} - ${zone.meta.page_rule_quota} Page Rules available.`);
        let description_file = findDescription(zone.name, argv.configDir.name);
        if (description_file) {
          console.log(chalk.keyword('purple')(`  Redirect description exists: ${description_file}`));
        }
        if (zone.status === 'pending') {
          console.log(chalk.keyword('lightblue')(`  Update the nameservers to: ${zone.name_servers.join(', ')}`));
        }
        db.put(zone.name, zone.id)
          .catch(console.error);
      });
      db.close();

      // list any redirect descriptions available which do not appear in Cloudflare
      let missing = argv.configDir.contents.filter((filename) => {
        return filename[0] !== '.'
          && zone_names.indexOf(filename.substr(0, filename.length-5)) === -1;
      });

      if (missing.length > 0) {
        console.log(`\nThe following ${chalk.bold(missing.length)} domains are not yet in Cloudflare:`);
        missing.forEach((li) => {
          console.log(` - ${li.substr(0, li.length-5)} (see ${path.join(argv.configDir.name, li)})`);
        });

        // ask if the user is ready to create the above missing zones
        console.log();
        inquirer.prompt({
          type: 'confirm',
          name: 'confirmCreateIntent',
          message: `Are you ready to create the missing zones on Cloudflare?`,
          default: false
        }).then((answers) => {
          if (answers.confirmCreateIntent) {
            // first, confirm which Cloudflare account (there should only be one)
            // ...so for now we just grab the first one...
            axios.get('/accounts')
              .then((resp) => {
                if (resp.data.success) {
                  let account_id = resp.data.result[0].id;
                  let account_name = resp.data.result[0].name;
                  // TODO: get confirmation on the account found?
                  console.log(`We'll be adding these to ${account_name}.`);

                  // now loop through each domain and offer to create it and add redirs
                  missing.forEach((filename) => {
                    let domain = filename.substr(0, filename.length-5);
                    inquirer.prompt({
                      type: 'confirm',
                      name: 'confirmCreate',
                      message: `Add ${domain} to ${account_name}?`,
                      default: false
                    }).then((answers) => {
                      if (answers.confirmCreate) {
                        axios.post('/zones', {
                            name: domain,
                            account: {id: account_id},
                            jump_start: true
                          })
                          .then((resp) => {
                            if (resp.data.success) {
                              console.log(`${chalk.bold(resp.data.result.name)} has been created and is ${chalk.bold(resp.data.result.status)}`);
                              let zone_id = resp.data.result.id;

                              // now let's add the page rules
                              let redir_filepath = path.join(process.cwd(),
                                                             argv.configDir.name,
                                                             filename);
                              try {
                                let description = YAML.safeLoad(fs.readFileSync((redir_filepath)));
                                description.redirects.forEach((redir) => {
                                  let pagerule = convertRedirectToPageRule(redir, `*${domain}`);
                                  console.log(`Does this Page Rule look OK?`);
                                  outputPageRulesAsText([pagerule]);
                                  inquirer.prompt({
                                    type: 'confirm',
                                    name: 'proceed',
                                    message: 'Shall we continue?',
                                    default: true
                                  }).then((answers) => {
                                    if (answers.proceed) {
                                      axios.post(`/zones/${zone_id}/pagerules`, {
                                          status: 'active',
                                          // splat in `targets` and `actions`
                                          ...pagerule
                                        })
                                        .then((resp) => {
                                          if (resp.data.success) {
                                            console.log('Page rule successfully created!');
                                            outputPageRulesAsText(resp.data.result);
                                          }
                                        })
                                        .catch(console.error);
                                    }
                                  });
                                });
                              } catch (err) {
                                console.error(err);
                              }
                            }
                          })
                          .catch((err) => {
                            // TODO: handle errors better... >_<
                            if ('response' in err
                                && 'status' in err.response
                                && err.response.status === 403) {
                              error(`The API token needs the ${chalk.bold('#zone.edit')} permissions enabled.`);
                            } else {
                              console.error(err);
                            }
                          });
                      }
                    });
                  });
                }
              })
              .catch((err) => {
                console.log(err);
                console.dir(err.response.data, {depth: 5});
              });
          }
        });
      }
    })
    .catch((err) => {
      console.error(err);
      console.error(err.response.data);
    });
};
